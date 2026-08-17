/**
 * The shared customer-facing brand cascade.
 *
 * Two screens thirty seconds apart in one handoff read this: the counter
 * display that shows the QR (/api/reservations/:id/display-data) and the
 * renter's own phone (/api/sign/:token). They used to disagree — the counter
 * hard-coded 'Ride Fleet' as its fallback while the phone resolved a real
 * cascade — so the same customer could be shown two different companies, one
 * of them a platform that is not a party to their contract.
 *
 * terms-signing.test.mjs covers the phone end to end. This file covers the
 * resolver itself, including the branch only the counter takes: it does NOT
 * hold the Tenant row, so the backstop has to be looked up.
 *
 * Run: node --test backend/src/lib/tenant-brand.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from './prisma.js';
import {
  resolveCustomerFacingBrand,
  resolveBrandLocation,
  PLATFORM_DEFAULT_COMPANY_NAME,
} from './tenant-brand.js';

let tenantLookups;
let settingsReads;
let franchiseReads;
let locationLookups;

beforeEach(() => {
  tenantLookups = [];
  settingsReads = 0;
  franchiseReads = 0;
  locationLookups = [];
  prisma.location = prisma.location || {};
  prisma.location.findUnique = async (args) => {
    locationLookups.push(args);
    return { id: args?.where?.id, name: 'Autos del Valle — Ponce', locationConfig: null };
  };
  // getRentalAgreementConfig / getAgreementConfig read these; unmocked they
  // would need a live database from a unit test.
  prisma.appSetting.findMany = async () => { settingsReads += 1; return []; };
  prisma.franchise.findFirst = async () => { franchiseReads += 1; return null; };
  // settingsService also reads Tenant (for the plan gate), so only the
  // resolver's own name lookup is counted here.
  prisma.tenant.findUnique = async (args) => {
    if (args?.select?.name === true) tenantLookups.push(args);
    return { id: args?.where?.id, plan: null, name: 'Autos del Valle LLC' };
  };
});

const loc = (name, companyName) => ({
  id: 'l1', name, locationConfig: companyName ? JSON.stringify({ companyName }) : null,
});

test('the location config wins the cascade', async () => {
  const out = await resolveCustomerFacingBrand({
    tenantId: 'tn1', location: loc('Ponce branch', 'Autos del Valle'), tenantName: 'ADV Holdings',
  });
  assert.equal(out.companyName, 'Autos del Valle');
});

test('the branch name carries when the location configures no company name', async () => {
  const out = await resolveCustomerFacingBrand({
    tenantId: 'tn1', location: loc('Autos del Valle — Ponce', null), tenantName: 'ADV Holdings',
  });
  assert.equal(out.companyName, 'Autos del Valle — Ponce');
});

test('a tenant-wide company name the tenant really set is used', async () => {
  prisma.appSetting.findMany = async () => [{ key: 'companyName', value: 'Autos del Valle' }];
  const out = await resolveCustomerFacingBrand({ tenantId: 'tn1', tenantName: 'ADV Holdings' });
  assert.equal(out.companyName, 'Autos del Valle');
});

test('the platform DEFAULT is not a company name and never wins', async () => {
  // getRentalAgreementConfig hands back DEFAULTS.companyName for any tenant
  // that never opened Settings → Rental agreement. Treating that as an answer
  // is precisely how our name reached a renter's contract screen.
  prisma.appSetting.findMany = async () => [{ key: 'companyName', value: PLATFORM_DEFAULT_COMPANY_NAME }];
  const out = await resolveCustomerFacingBrand({ tenantId: 'tn1', tenantName: 'ADV Holdings' });
  assert.equal(out.companyName, 'ADV Holdings');
});

test('nothing configured anywhere returns null, not the platform name', async () => {
  const out = await resolveCustomerFacingBrand({ tenantId: null, tenantName: null });
  assert.equal(out.companyName, null);
});

// ---------------------------------------------------------------------------
// The counter display's branch: it has a tenantId but not the Tenant row
// ---------------------------------------------------------------------------

test('a caller without the Tenant row gets the backstop looked up', async () => {
  const out = await resolveCustomerFacingBrand({ tenantId: 'tn1' });
  assert.equal(out.companyName, 'Autos del Valle LLC');
  assert.equal(tenantLookups.length, 1);
  assert.deepEqual(tenantLookups[0], { where: { id: 'tn1' }, select: { name: true } });
});

test('the backstop is never read when the cascade already answered', async () => {
  // This runs on a screen the agent polls every few seconds — an extra query
  // per poll for a value that loses anyway is not free.
  const out = await resolveCustomerFacingBrand({ tenantId: 'tn1', location: loc('Ponce branch', null) });
  assert.equal(out.companyName, 'Ponce branch');
  assert.equal(tenantLookups.length, 0, 'no tenant lookup on the common path');
});

test('a caller that already holds the Tenant row never triggers a lookup', async () => {
  const out = await resolveCustomerFacingBrand({ tenantId: 'tn1', tenantName: 'ADV Holdings' });
  assert.equal(out.companyName, 'ADV Holdings');
  assert.equal(tenantLookups.length, 0);
});

test('a failing backstop lookup degrades to null instead of throwing', async () => {
  prisma.tenant.findUnique = async () => { throw new Error('db down'); };
  const out = await resolveCustomerFacingBrand({ tenantId: 'tn1' });
  assert.equal(out.companyName, null);
});

test('a failing settings lookup never breaks the surface that renders it', async () => {
  prisma.appSetting.findMany = async () => { throw new Error('db down'); };
  const out = await resolveCustomerFacingBrand({ tenantId: 'tn1', tenantName: 'ADV Holdings' });
  assert.equal(out.companyName, 'ADV Holdings');
});

// ---------------------------------------------------------------------------
// What the resolver may cost a screen that polls
//
// display-data is fetched every 1.5s per open counter screen. Neither
// getRentalAgreementConfig nor the franchise read is memoised, so a resolver
// that fetched what its caller had already fetched would add ~80 redundant
// queries a minute per till — and a sequential round trip before the response
// could render.
// ---------------------------------------------------------------------------

test('an injected settings config is used instead of re-read', async () => {
  const out = await resolveCustomerFacingBrand({
    tenantId: 'tn1',
    globalConfig: { companyName: 'Autos del Valle' },
    franchiseConfig: null,
    tenantName: 'ADV Holdings',
  });
  assert.equal(out.companyName, 'Autos del Valle');
  assert.equal(settingsReads, 0, 'settings must not be fetched twice');
  assert.equal(franchiseReads, 0, 'franchise must not be fetched twice');
});

test('an injected PLATFORM DEFAULT is still filtered, not trusted', async () => {
  const out = await resolveCustomerFacingBrand({
    tenantId: 'tn1',
    globalConfig: { companyName: PLATFORM_DEFAULT_COMPANY_NAME },
    franchiseConfig: null,
    tenantName: 'ADV Holdings',
  });
  assert.equal(out.companyName, 'ADV Holdings');
});

test('a caller that injects nothing still fetches for itself', async () => {
  // The signing path has no prefetched config, so omission must keep working.
  await resolveCustomerFacingBrand({ tenantId: 'tn1', tenantName: 'ADV Holdings' });
  assert.equal(settingsReads, 1);
  assert.equal(franchiseReads, 1);
});

// ---------------------------------------------------------------------------
// WHICH branch — the half that keeps the counter and the phone in agreement
// ---------------------------------------------------------------------------

test('an already-loaded agreement branch is used without a query', async () => {
  // The phone's token query loads it; re-reading would be pure waste.
  const agreementBranch = { id: 'l1', name: 'Autos del Valle — Ponce', locationConfig: null };
  const out = await resolveBrandLocation({
    pickupLocation: { id: 'l2', name: 'Autos del Valle — Mayagüez', locationConfig: null },
    rentalAgreement: { pickupLocationId: 'l1', pickupLocation: agreementBranch },
  });
  assert.equal(out, agreementBranch);
  assert.equal(locationLookups.length, 0);
});

test('a moved reservation reads the AGREEMENT branch, once', async () => {
  // The counter screen holds only the agreement's id (getById does not load
  // that relation), so this is the one case that costs a query.
  const out = await resolveBrandLocation({
    pickupLocation: { id: 'l2', name: 'Autos del Valle — Mayagüez', locationConfig: null },
    rentalAgreement: { pickupLocationId: 'l1' },
  });
  assert.equal(out.id, 'l1');
  assert.equal(locationLookups.length, 1);
  assert.deepEqual(locationLookups[0].where, { id: 'l1' });
});

test('an unmoved reservation costs nothing', async () => {
  const branch = { id: 'l1', name: 'Autos del Valle — Ponce', locationConfig: null };
  const out = await resolveBrandLocation({
    pickupLocation: branch,
    rentalAgreement: { pickupLocationId: 'l1' },
  });
  assert.equal(out, branch);
  assert.equal(locationLookups.length, 0, 'no query when the two already agree');
});

test('a reservation with no agreement yet uses its own branch', async () => {
  // The counter screen renders long before an agreement exists.
  const branch = { id: 'l2', name: 'Autos del Valle — Mayagüez', locationConfig: null };
  const out = await resolveBrandLocation({ pickupLocation: branch, rentalAgreement: null });
  assert.equal(out, branch);
  assert.equal(locationLookups.length, 0);
});

test('a failed branch lookup degrades to the reservation branch, not to nothing', async () => {
  prisma.location.findUnique = async () => { throw new Error('db down'); };
  const branch = { id: 'l2', name: 'Autos del Valle — Mayagüez', locationConfig: null };
  const out = await resolveBrandLocation({
    pickupLocation: branch,
    rentalAgreement: { pickupLocationId: 'l1' },
  });
  assert.equal(out, branch);
});
