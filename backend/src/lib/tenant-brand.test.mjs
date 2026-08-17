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
import { resolveCustomerFacingBrand, PLATFORM_DEFAULT_COMPANY_NAME } from './tenant-brand.js';

let tenantLookups;

beforeEach(() => {
  tenantLookups = [];
  // getRentalAgreementConfig / getAgreementConfig read these; unmocked they
  // would need a live database from a unit test.
  prisma.appSetting.findMany = async () => [];
  prisma.franchise.findFirst = async () => null;
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
