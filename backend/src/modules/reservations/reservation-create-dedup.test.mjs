/**
 * STAFF reservation-create SHORT-WINDOW CONTENT DEDUP (2026-08-24).
 *
 * BUG (prod): a real agent's rapid double/triple-click (or a client retry)
 * created 2-4 IDENTICAL reservations within ~0.9-1.3s. The frontend mints a
 * fresh `reservationNumber` per submit, so the UNIQUE index on
 * reservationNumber never caught them — same customerId/pickupAt/returnAt/
 * vehicleTypeId, different number each time.
 *
 * FIX (reservations.routes.js POST '/'): immediately before creating, look for
 * an existing reservation in the SAME tenant with the same
 *   createdByUserId + customerId + pickupAt + returnAt + vehicleTypeId
 * created in the last 10 seconds. If found, RETURN THAT reservation with the
 * normal 201 shape instead of minting a duplicate.
 *
 * This proves, at the ROUTER (the unit the fix lives in):
 *   1. Two identical rapid submits → ONE reservation; the 2nd returns the 1st's
 *      row and reservationsService.create is NOT called a second time.
 *   2. A DIFFERENT reservation (different customer / dates) still creates.
 *   3. A submit OUTSIDE the 10s window still creates (the guard is time-boxed).
 *
 * Harness follows display-data-brand.test.mjs: bare Express app, node's own
 * http client, no supertest dep; every service/prisma call the handler makes
 * before the create is stubbed, and prisma.reservation.findFirst is backed by a
 * tiny in-memory store that honors the dedup WHERE (tenant, keys, createdAt.gt)
 * so all three cases fall out of one mock. DB-backed; runs off any DB.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { prisma } from '../../lib/prisma.js';
import { reservationsRouter } from './reservations.routes.js';
import { reservationsService } from './reservations.service.js';
import { ratesService } from '../rates/rates.service.js';
import { settingsService } from '../settings/settings.service.js';
import { parseDateTimeInTz, DEFAULT_TENANT_TIMEZONE } from '../../lib/date-utils.js';

const PICKUP_STR = '2026-09-01T10:00';
const RETURN_STR = '2026-09-05T10:00';
// The route normalizes the naive datetime-local strings through the tenant TZ
// before it stores/queries them; getReservationOptions is stubbed to {} so the
// TZ falls to DEFAULT — we normalize our stored fixture the exact same way so
// the Date equality in the dedup WHERE lines up.
const PICKUP_AT = parseDateTimeInTz(PICKUP_STR, DEFAULT_TENANT_TIMEZONE);
const RETURN_AT = parseDateTimeInTz(RETURN_STR, DEFAULT_TENANT_TIMEZONE);

let server;
let port;
let store;          // in-memory reservations for the dedup lookup
let createCalls;    // how many times reservationsService.create ran

function existingRow(overrides = {}) {
  return {
    id: 'r-existing',
    tenantId: 't1',
    reservationNumber: 'RES-EXISTING',
    status: 'CONFIRMED',
    createdByUserId: 'u1',
    customerId: 'cust-1',
    vehicleTypeId: 'vt-1',
    pickupAt: PICKUP_AT,
    returnAt: RETURN_AT,
    createdAt: new Date(Date.now() - 1000), // 1s ago → inside the 10s window
    customer: { id: 'cust-1', firstName: 'Ada', lastName: 'Reyes', email: 'a@x.com', phone: '555' },
    ...overrides,
  };
}

function submitBody(overrides = {}) {
  return {
    reservationNumber: `RES-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    customerId: 'cust-1',
    vehicleTypeId: 'vt-1',
    pickupAt: PICKUP_STR,
    returnAt: RETURN_STR,
    pickupLocationId: 'loc-1',
    returnLocationId: 'loc-1',
    dailyRate: 45,
    estimatedTotal: 180,
    addOnsTotal: 0,
    status: 'CONFIRMED',
    sendConfirmationEmail: false,
    bookingChannel: 'STAFF',
    ...overrides,
  };
}

function post(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      method: 'POST',
      hostname: '127.0.0.1',
      port,
      path: '/api/reservations',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw, json: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: 'u1', tenantId: 't1', role: 'ADMIN' }; next(); });
  app.use('/api/reservations', reservationsRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  // TZ resolution (route + lib/tenant-tz dynamic import share this singleton).
  settingsService.getReservationOptions = async () => ({});

  // withTenantSchema resolves the tenant schema before running its callback;
  // 'public' keeps every db.* call on the (stubbed) public prisma client.
  prisma.tenant.findUnique = async (args) => ({ id: args?.where?.id, schemaName: 'public', tier: 'STANDARD', name: 'T1' });

  // Everything the handler touches BEFORE the dedup/create.
  ratesService.rentalMinimumFor = async () => ({ minimumHours: 0 });
  ratesService.resolveForRental = async () => ({ baseTotal: 100, dailyRate: 45, days: 4 });
  // Serves both the handler's pickupLoc read and previewLocationMandatoryFees.
  prisma.location.findFirst = async () => ({ locationConfig: null, taxRate: 0, locationFees: [] });

  // Downstream of a REAL create (snapshot + audit) — only hit when we don't dedup.
  prisma.reservationPricingSnapshot.upsert = async () => ({});
  prisma.auditLog.create = async () => ({});

  // The dedup lookup, backed by the in-memory store honoring the real WHERE.
  prisma.reservation.findFirst = async ({ where = {} } = {}) => {
    const cutoff = where.createdAt?.gt ? new Date(where.createdAt.gt).getTime() : -Infinity;
    const matches = store.filter((r) => {
      if (where.tenantId !== undefined && r.tenantId !== where.tenantId) return false;
      if (where.createdByUserId !== undefined && r.createdByUserId !== where.createdByUserId) return false;
      if (where.customerId !== undefined && r.customerId !== where.customerId) return false;
      if (where.vehicleTypeId !== undefined && r.vehicleTypeId !== where.vehicleTypeId) return false;
      if (where.pickupAt !== undefined && new Date(r.pickupAt).getTime() !== new Date(where.pickupAt).getTime()) return false;
      if (where.returnAt !== undefined && new Date(r.returnAt).getTime() !== new Date(where.returnAt).getTime()) return false;
      if (new Date(r.createdAt).getTime() <= cutoff) return false;
      return true;
    });
    matches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return matches[0] || null;
  };

  // A "real" create just records the call and mints a fresh row.
  reservationsService.create = async (data) => {
    createCalls += 1;
    return {
      id: `r-new-${createCalls}`,
      tenantId: 't1',
      reservationNumber: data.reservationNumber,
      status: data.status || 'CONFIRMED',
      customerId: data.customerId,
    };
  };
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  store = [];
  createCalls = 0;
});

test('two identical rapid submits → ONE reservation; the 2nd returns the 1st and does NOT create', async () => {
  // Simulate: the first submit already committed R1 ~1s ago; the double-click's
  // second submit arrives now with the same key fields (fresh number).
  store.push(existingRow());
  const res = await post(submitBody({ reservationNumber: 'RES-SECOND-CLICK' }));

  assert.equal(res.status, 201, res.body);
  assert.equal(res.json.id, 'r-existing', 'the duplicate submit is pointed at the ONE real reservation');
  assert.equal(res.json.reservationNumber, 'RES-EXISTING');
  assert.equal(createCalls, 0, 'no second row was created');
});

test('a DIFFERENT customer still creates normally', async () => {
  store.push(existingRow());
  const res = await post(submitBody({ customerId: 'cust-2' }));

  assert.equal(res.status, 201, res.body);
  assert.equal(createCalls, 1, 'a genuinely different reservation is created');
  assert.equal(res.json.id, 'r-new-1');
  assert.equal(res.json.customerId, 'cust-2');
});

test('DIFFERENT dates (same customer) still create normally', async () => {
  store.push(existingRow());
  const res = await post(submitBody({ pickupAt: '2026-10-01T10:00', returnAt: '2026-10-05T10:00' }));

  assert.equal(res.status, 201, res.body);
  assert.equal(createCalls, 1, 'the dedup key includes the dates, so a re-date is not a duplicate');
  assert.equal(res.json.id, 'r-new-1');
});

test('an identical submit OUTSIDE the 10s window still creates normally', async () => {
  // Same key fields, but the prior reservation is 30s old — past the guard.
  store.push(existingRow({ createdAt: new Date(Date.now() - 30_000) }));
  const res = await post(submitBody());

  assert.equal(res.status, 201, res.body);
  assert.equal(createCalls, 1, 'the guard is time-boxed to 10s; an older match is not deduped');
  assert.equal(res.json.id, 'r-new-1');
});

test('with NO prior reservation, the first submit creates normally', async () => {
  const res = await post(submitBody());

  assert.equal(res.status, 201, res.body);
  assert.equal(createCalls, 1);
  assert.equal(res.json.id, 'r-new-1');
});
