/**
 * The COUNTER half of the tenant-identity fix, tested where it actually lives.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * tenant-brand.test.mjs proves the resolver keeps the counter screen and the
 * renter's phone on the same branch — by calling `resolveBrandLocation`
 * directly. That is the helper, not the caller. Nothing exercised the WIRING in
 * reservations.routes.js's /:id/display-data handler, so the two edits that
 * matter most there were unprotected:
 *
 *   • `location: brandLocation` — reverting it to `row?.pickupLocation ?? null`
 *     puts the counter back on the reservation's branch while the phone stays
 *     on the agreement's, which is the exact disagreement this branch closed;
 *   • `globalConfig` / `franchiseConfig` — dropping either makes the resolver
 *     re-fetch what this handler already fetched, on an endpoint polled every
 *     1.5s per open till.
 *
 * Either revert left all 52 existing tests green. These two do not.
 *
 * Harness follows terms-signing.routes.test.mjs: bare Express app, node's own
 * http client, no supertest dep. The router is the unit under test; every
 * service behind it is stubbed, including the tenant-routing lookup that
 * `withTenantSchema` makes before it hands the callback a client.
 *
 * Run: node --test backend/src/modules/reservations/display-data-brand.test.mjs
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../lib/prisma.js';
import { reservationsRouter } from './reservations.routes.js';
import { reservationsService } from './reservations.service.js';
import { settingsService } from '../settings/settings.service.js';
import { franchiseService } from '../settings/franchise.service.js';

const AGREEMENT_BRANCH = { id: 'l1', name: 'Autos del Valle — Ponce', locationConfig: null };
const RESERVATION_BRANCH = { id: 'l2', name: 'Autos del Valle — Mayagüez', locationConfig: null };

let server;
let settingsReads;
let franchiseReads;
let row;

/** The reservation getById hands back: moved AFTER its agreement was created. */
function movedReservation({ pickupLocation = RESERVATION_BRANCH } = {}) {
  return {
    id: 'r1', tenantId: 't1', reservationNumber: 'RES-1', franchiseId: null,
    pickupLocation,
    // getById selects the agreement's pickupLocationId but NOT the relation —
    // which is precisely why the counter is the side that pays for a query.
    rentalAgreement: { id: 'a1', tenantId: 't1', pickupLocationId: AGREEMENT_BRANCH.id },
  };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: 'u1', tenantId: 't1', role: 'ADMIN' }; next(); });
  app.use('/api/reservations', reservationsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  settingsReads = 0;
  franchiseReads = 0;
  row = movedReservation();

  reservationsService.getById = async () => row;

  // withTenantSchema resolves the tenant's schema before running its callback;
  // 'public' is the fast path every tenant is on today, and it keeps this unit
  // test off a database.
  prisma.tenant.findUnique = async (args) => ({ id: args?.where?.id, schemaName: 'public', tier: 'STANDARD', name: 'ADV Holdings' });
  prisma.reservationCharge.findMany = async () => [];
  prisma.additionalService.findMany = async () => [];
  prisma.location = prisma.location || {};
  prisma.location.findFirst = async ({ where }) => (
    where?.id === AGREEMENT_BRANCH.id ? AGREEMENT_BRANCH : null
  );

  settingsService.getInsurancePlans = async () => [];
  settingsService.getRentalAgreementConfig = async () => { settingsReads += 1; return {}; };
  franchiseService.getAgreementConfig = async () => { franchiseReads += 1; return null; };
});

function displayData(id = 'r1') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method: 'GET',
      hostname: '127.0.0.1',
      port: server.address().port,
      path: `/api/reservations/${id}/display-data`,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw, json: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// WHICH branch the counter names
// ---------------------------------------------------------------------------

test('the counter screen names the AGREEMENT branch after a move', async () => {
  // The phone resolves the agreement's branch (terms-signing.test.mjs). If this
  // endpoint went back to reading `row.pickupLocation`, the same customer would
  // be shown Mayagüez on the counter and Ponce on their phone, thirty seconds
  // apart in one handoff.
  const res = await displayData();
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json.branding.companyName, AGREEMENT_BRANCH.name);
  assert.notEqual(
    res.json.branding.companyName, RESERVATION_BRANCH.name,
    'the reservation branch is the FALLBACK, not the answer',
  );
});

test('an unmoved reservation still names its own branch', async () => {
  row = movedReservation({ pickupLocation: AGREEMENT_BRANCH });
  row.rentalAgreement.pickupLocationId = AGREEMENT_BRANCH.id;
  const res = await displayData();
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json.branding.companyName, AGREEMENT_BRANCH.name);
});

test('a reservation with no agreement yet falls back to its own branch', async () => {
  // The counter screen renders long before an agreement exists.
  row = movedReservation();
  row.rentalAgreement = null;
  const res = await displayData();
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json.branding.companyName, RESERVATION_BRANCH.name);
});

// ---------------------------------------------------------------------------
// What this endpoint costs — it is polled every 1.5s per open till
// ---------------------------------------------------------------------------

test('the settings this handler already fetched are INJECTED, not re-read', async () => {
  // Distinct values per call, so this fails on the value and not only on the
  // count: a resolver left to fetch for itself gets the SECOND read.
  settingsService.getRentalAgreementConfig = async () => {
    settingsReads += 1;
    return { companyName: settingsReads === 1 ? 'Autos del Valle' : 'A SECOND SETTINGS READ' };
  };
  // Nameless branch, so the tenant-wide setting is what the cascade lands on.
  row = movedReservation({ pickupLocation: { id: 'l2', name: '', locationConfig: null } });
  row.rentalAgreement.pickupLocationId = null;

  const res = await displayData();
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json.branding.companyName, 'Autos del Valle');
  assert.equal(settingsReads, 1, 'getRentalAgreementConfig is not memoised — fetching it twice per poll is ~40 wasted queries a minute per screen');
});

test('the franchise config this handler already fetched is INJECTED, not re-read', async () => {
  franchiseService.getAgreementConfig = async () => {
    franchiseReads += 1;
    return { companyName: franchiseReads === 1 ? 'Franquicia Norte' : 'A SECOND FRANCHISE READ' };
  };
  row = movedReservation({ pickupLocation: { id: 'l2', name: '', locationConfig: null } });
  row.rentalAgreement.pickupLocationId = null;
  row.franchiseId = 'f1';

  const res = await displayData();
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json.branding.companyName, 'Franquicia Norte');
  assert.equal(franchiseReads, 1, 'the franchise read is not memoised either');
});

// ---------------------------------------------------------------------------
// The leak itself
// ---------------------------------------------------------------------------

test("the platform's own name never reaches the counter", async () => {
  // What an unconfigured tenant reads back from getRentalAgreementConfig. The
  // counter used to print it verbatim while the phone printed the tenant's.
  settingsService.getRentalAgreementConfig = async () => { settingsReads += 1; return { companyName: 'Ride Fleet' }; };
  row = movedReservation({ pickupLocation: { id: 'l2', name: '', locationConfig: null } });
  row.rentalAgreement.pickupLocationId = null;

  const res = await displayData();
  assert.equal(res.status, 200, res.body);
  assert.notEqual(res.json.branding.companyName, 'Ride Fleet');
  assert.equal(res.json.branding.companyName, 'ADV Holdings', 'the Tenant.name backstop, not ours');
});
