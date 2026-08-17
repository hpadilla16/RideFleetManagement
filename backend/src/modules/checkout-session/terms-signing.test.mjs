/**
 * Tests for the public T&C signing service.
 * Run: node --test backend/src/modules/checkout-session/terms-signing.test.mjs
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { termsSigningService } from './terms-signing.service.js';
import { TC_SECTIONS } from './terms-content.js';

const FUTURE = new Date(Date.now() + 15 * 60_000);
const PAST = new Date(Date.now() - 60_000);
const FAKE_DATA_URL = 'data:image/png;base64,' + 'A'.repeat(500);

let upserts;
let txOps;
function reset() {
  upserts = [];
  txOps = [];
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'TOK', kind: 'TERMS_SIGNING',
    expiresAt: FUTURE, consumedAt: null,
    reservationId: 'r1',
    reservation: {
      id: 'r1', reservationNumber: 'RES-1', customerId: 'c1',
      rentalAgreement: { id: 'a1', declinedInsurance: false, agreementNumber: 'RA-1' },
    },
  });
  prisma.agreementSectionInitial.findMany = async () => [];
  // Brand resolution (resolveSigningBrand) reads the rental-agreement
  // settings + franchise on top of the token row. Unmocked these would hit a
  // real database from a unit test.
  prisma.appSetting.findMany = async () => [];
  prisma.tenant.findUnique = async () => null;
  prisma.franchise.findFirst = async () => null;
  prisma.agreementSectionInitial.upsert = async (op) => { upserts.push(op); return {}; };
  prisma.checkoutSession.findUnique = async () => ({ id: 's1', events: '[]', reservationId: 'r1' });
  prisma.$transaction = async (ops) => { txOps = ops; return ops; };
  prisma.rentalAgreement.update = async () => ({});
  prisma.checkoutSession.update = async () => ({});
  prisma.handoffToken.update = async () => ({});
}

beforeEach(() => reset());

// ---------------------------------------------------------------------------
// loadSession
// ---------------------------------------------------------------------------

test('loadSession returns canonical sections when not declined', async () => {
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.sections.length, TC_SECTIONS.length);
  for (const s of out.sections) {
    assert.equal(s.signed, false, 'all unsigned initially');
  }
});

test('loadSession injects declined-insurance section when flag is true', async () => {
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'TOK', kind: 'TERMS_SIGNING',
    expiresAt: FUTURE, consumedAt: null, reservationId: 'r1',
    reservation: {
      id: 'r1', reservationNumber: 'RES-1', customerId: 'c1',
      rentalAgreement: { id: 'a1', declinedInsurance: true, agreementNumber: 'RA-1' },
    },
  });
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.sections.length, TC_SECTIONS.length + 1);
  assert.ok(out.sections.some((s) => s.key === 'declined_insurance'));
});

test('loadSession reflects signed state from prior initials', async () => {
  prisma.agreementSectionInitial.findMany = async () => [
    { sectionKey: 'rental_period', signedAt: new Date() },
  ];
  const out = await termsSigningService.loadSession('TOK');
  const rp = out.sections.find((s) => s.key === 'rental_period');
  assert.equal(rp.signed, true);
});

// ---------------------------------------------------------------------------
// Tenant identity on the customer's phone (gap #11)
//
// The customer scans a QR and lands here with no other context. Whatever this
// payload says is who they believe they are signing a contract with, so the
// one thing it must never say is the platform's own name.
// ---------------------------------------------------------------------------

/** Token row with the brand-relevant relations the resolver reads. */
function tokenRowWith({ location = null, tenant = null, customerLocale = null, franchiseId = null } = {}) {
  return {
    id: 't1', token: 'TOK', kind: 'TERMS_SIGNING',
    expiresAt: FUTURE, consumedAt: null, reservationId: 'r1',
    reservation: {
      id: 'r1', reservationNumber: 'RES-1', customerId: 'c1', franchiseId,
      customer: customerLocale ? { locale: customerLocale } : null,
      rentalAgreement: {
        id: 'a1', declinedInsurance: false, agreementNumber: 'RA-1',
        tenantId: tenant ? tenant.id : null,
        tenant,
        pickupLocation: location,
      },
    },
  };
}

test('brand prefers the location config company name', async () => {
  prisma.handoffToken.findUnique = async () => tokenRowWith({
    location: { id: 'l1', name: 'Branch Name', locationConfig: JSON.stringify({ companyName: 'Autos del Valle' }) },
    tenant: { id: 'tn1', name: 'Tenant Legal Name' },
  });
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.brand.companyName, 'Autos del Valle');
});

test('brand falls back to the branch name when the location sets none', async () => {
  prisma.handoffToken.findUnique = async () => tokenRowWith({
    location: { id: 'l1', name: 'Autos del Valle — Ponce', locationConfig: null },
    tenant: { id: 'tn1', name: 'Tenant Legal Name' },
  });
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.brand.companyName, 'Autos del Valle — Ponce');
});

test('brand falls back to the plain tenant name when nothing else is set', async () => {
  prisma.handoffToken.findUnique = async () => tokenRowWith({
    location: null,
    tenant: { id: 'tn1', name: 'Autos del Valle LLC' },
  });
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.brand.companyName, 'Autos del Valle LLC');
});

test('brand never falls through to the platform name for an unconfigured tenant', async () => {
  // getRentalAgreementConfig returns DEFAULTS.companyName = 'Ride Fleet' for
  // any tenant that never filled in Settings → Rental agreement. That default
  // must lose to the tenant's own name, or the renter signs a contract that
  // appears to be with us.
  prisma.appSetting.findMany = async () => [{ key: 'companyName', value: 'Ride Fleet' }];
  prisma.handoffToken.findUnique = async () => tokenRowWith({
    location: null,
    tenant: { id: 'tn1', name: 'Autos del Valle LLC' },
  });
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.brand.companyName, 'Autos del Valle LLC');
  assert.notEqual(out.brand.companyName, 'Ride Fleet');
});

test('a tenant that really configured a company name keeps it', async () => {
  prisma.appSetting.findMany = async () => [{ key: 'companyName', value: 'Autos del Valle' }];
  prisma.handoffToken.findUnique = async () => tokenRowWith({
    location: null,
    tenant: { id: 'tn1', name: 'ADV Holdings Inc' },
  });
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.brand.companyName, 'Autos del Valle');
});

test('brand is null (not the platform name) when every source is empty', async () => {
  prisma.handoffToken.findUnique = async () => tokenRowWith({ location: null, tenant: null });
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.brand.companyName, null);
});

test('brand resolution failure never breaks loading the contract', async () => {
  prisma.appSetting.findMany = async () => { throw new Error('db down'); };
  prisma.handoffToken.findUnique = async () => tokenRowWith({
    location: null, tenant: { id: 'tn1', name: 'Autos del Valle LLC' },
  });
  const out = await termsSigningService.loadSession('TOK');
  assert.equal(out.sections.length, TC_SECTIONS.length, 'sections still load');
  assert.equal(out.brand.companyName, 'Autos del Valle LLC');
});

test('signerLocale echoes the customer preference, normalized', async () => {
  prisma.handoffToken.findUnique = async () => tokenRowWith({ customerLocale: 'es-PR' });
  assert.equal((await termsSigningService.loadSession('TOK')).signerLocale, 'es');
  prisma.handoffToken.findUnique = async () => tokenRowWith({ customerLocale: 'en-US' });
  assert.equal((await termsSigningService.loadSession('TOK')).signerLocale, 'en');
});

test('signerLocale is null for missing or unsupported locales', async () => {
  prisma.handoffToken.findUnique = async () => tokenRowWith({ customerLocale: null });
  assert.equal((await termsSigningService.loadSession('TOK')).signerLocale, null);
  prisma.handoffToken.findUnique = async () => tokenRowWith({ customerLocale: 'fr-CA' });
  assert.equal((await termsSigningService.loadSession('TOK')).signerLocale, null);
});

test('the public payload carries no signer, vehicle or money data', async () => {
  prisma.handoffToken.findUnique = async () => tokenRowWith({
    location: { id: 'l1', name: 'Ponce', locationConfig: null },
    tenant: { id: 'tn1', name: 'Autos del Valle LLC' },
  });
  const out = await termsSigningService.loadSession('TOK');
  // brand is rendered into a public, cacheable <title> — business identity only.
  assert.deepEqual(Object.keys(out.brand), ['companyName']);
});

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

test('expired token throws 410', async () => {
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'X', kind: 'TERMS_SIGNING',
    expiresAt: PAST, consumedAt: null, reservationId: 'r1',
    reservation: { id: 'r1', rentalAgreement: { id: 'a1' } },
  });
  await assert.rejects(
    () => termsSigningService.loadSession('X'),
    (err) => err.status === 410 && err.code === 'TOKEN_EXPIRED',
  );
});

test('consumed token throws 410', async () => {
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'X', kind: 'TERMS_SIGNING',
    expiresAt: FUTURE, consumedAt: new Date(), reservationId: 'r1',
    reservation: { id: 'r1', rentalAgreement: { id: 'a1' } },
  });
  await assert.rejects(
    () => termsSigningService.loadSession('X'),
    (err) => err.status === 410 && err.code === 'TOKEN_CONSUMED',
  );
});

test('wrong-kind token throws 410', async () => {
  prisma.handoffToken.findUnique = async () => ({
    id: 't1', token: 'X', kind: 'MOBILE_INSPECTION',
    expiresAt: FUTURE, consumedAt: null, reservationId: 'r1',
    reservation: { id: 'r1', rentalAgreement: { id: 'a1' } },
  });
  await assert.rejects(
    () => termsSigningService.loadSession('X'),
    (err) => err.status === 410 && err.code === 'TOKEN_WRONG_KIND',
  );
});

// ---------------------------------------------------------------------------
// saveInitial
// ---------------------------------------------------------------------------

test('saveInitial upserts the right section', async () => {
  await termsSigningService.saveInitial({
    token: 'TOK',
    sectionKey: 'rental_period',
    initialDataUrl: FAKE_DATA_URL,
    customerIp: '1.2.3.4',
  });
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].create.sectionKey, 'rental_period');
  assert.equal(upserts[0].create.customerIp, '1.2.3.4');
});

test('saveInitial rejects unknown sectionKey', async () => {
  await assert.rejects(
    () => termsSigningService.saveInitial({ token: 'TOK', sectionKey: 'made_up', initialDataUrl: FAKE_DATA_URL }),
    (err) => err.status === 400,
  );
});

test('saveInitial rejects tiny dataURL', async () => {
  await assert.rejects(
    () => termsSigningService.saveInitial({ token: 'TOK', sectionKey: 'rental_period', initialDataUrl: 'data:,' }),
    (err) => err.status === 400,
  );
});

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

test('complete fails when any section missing', async () => {
  prisma.agreementSectionInitial.findMany = async () => [
    { sectionKey: 'rental_period' },
  ];
  await assert.rejects(
    () => termsSigningService.complete({ token: 'TOK', signatureDataUrl: FAKE_DATA_URL, signerName: 'Erick Bou' }),
    (err) => err.code === 'INITIALS_INCOMPLETE',
  );
});

test('complete fires a transaction with three updates when all sections initialed', async () => {
  prisma.agreementSectionInitial.findMany = async () => TC_SECTIONS.map((s) => ({ sectionKey: s.key }));
  const r = await termsSigningService.complete({ token: 'TOK', signatureDataUrl: FAKE_DATA_URL, signerName: 'Erick Bou' });
  assert.equal(r.ok, true);
  assert.equal(txOps.length, 3, 'agreement update + session update + token consume');
});
