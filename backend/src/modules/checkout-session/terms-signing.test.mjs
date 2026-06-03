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
