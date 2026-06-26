/**
 * Integration tests for the desktop customer-signature endpoint
 * (checkoutSessionService.saveCustomerSignature) and the loaner
 * customer-request date validation (dealershipLoanerService.resolveCustomerRequest).
 *
 * Requires a live Postgres via DATABASE_URL (same convention as the other
 * DB-backed suites in this repo, e.g. loaner-agreement.test.mjs).
 *
 * Covers the 2026-06-26 audit follow-ups:
 *   - Step 6 desktop signature is real (persists to agreement + stamps customerSignedAt)
 *   - M1: resolveCustomerRequest rejects past / invalid requested return dates
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { checkoutSessionService } from './checkout-session.service.js';
import { dealershipLoanerService } from '../dealership-loaner/dealership-loaner.service.js';

const prisma = new PrismaClient();
const SUFFIX = `SIGTEST-${Date.now()}`;
const ids = { reservations: [], agreements: [], loaners: [], sessions: [], customer: null, location: null };

test.after(async () => {
  // Best-effort cleanup so reruns don't collide on unique numbers.
  await prisma.checkoutSession.deleteMany({ where: { id: { in: ids.sessions } } }).catch(() => {});
  await prisma.loanerAgreement.deleteMany({ where: { id: { in: ids.loaners } } }).catch(() => {});
  await prisma.rentalAgreement.deleteMany({ where: { id: { in: ids.agreements } } }).catch(() => {});
  await prisma.reservation.deleteMany({ where: { id: { in: ids.reservations } } }).catch(() => {});
  if (ids.location) await prisma.location.delete({ where: { id: ids.location } }).catch(() => {});
  if (ids.customer) await prisma.customer.delete({ where: { id: ids.customer } }).catch(() => {});
  await prisma.$disconnect();
});

async function base() {
  const cust = await prisma.customer.create({ data: { firstName: 'Sig', lastName: 'Test', phone: '7875550000' } });
  const loc = await prisma.location.create({ data: { code: `ST-${SUFFIX}`.slice(0, 12), name: 'SigTest Loc' } });
  ids.customer = cust.id; ids.location = loc.id;
  return { cust, loc };
}
async function mkReservation(seed, num, mode = 'RENTAL') {
  const now = Date.now();
  const r = await prisma.reservation.create({ data: {
    reservationNumber: num, customerId: seed.cust.id, pickupLocationId: seed.loc.id, returnLocationId: seed.loc.id,
    pickupAt: new Date(now - 86400e3), returnAt: new Date(now + 86400e3), workflowMode: mode } });
  ids.reservations.push(r.id);
  return r;
}

test('saveCustomerSignature persists the signature to the agreement and stamps customerSignedAt', async () => {
  const seed = await base();
  const r = await mkReservation(seed, `RES-${SUFFIX}-1`);
  const ag = await prisma.rentalAgreement.create({ data: {
    agreementNumber: `AG-${SUFFIX}-1`, reservationId: r.id, pickupLocationId: seed.loc.id, returnLocationId: seed.loc.id,
    pickupAt: r.pickupAt, returnAt: r.returnAt, customerFirstName: 'Sig', customerLastName: 'Test' } });
  ids.agreements.push(ag.id);
  const s = await prisma.checkoutSession.create({ data: { reservationId: r.id, agreementId: ag.id, events: '[]' } });
  ids.sessions.push(s.id);

  const sig = 'data:image/png;base64,' + 'A'.repeat(400);
  const out = await checkoutSessionService.saveCustomerSignature({ id: s.id, signatureDataUrl: sig, signerName: 'Sig Test', customerIp: '1.2.3.4' });
  assert.ok(out.customerSignedAt, 'session.customerSignedAt stamped');

  const after = await prisma.rentalAgreement.findUnique({ where: { id: ag.id } });
  assert.equal(after.tcSignatureDataUrl, sig, 'signature image saved on agreement');
  assert.ok(after.tcSignedAt, 'tcSignedAt set');
  assert.equal(after.tcSignerName, 'Sig Test');
  assert.equal(after.tcCustomerIp, '1.2.3.4');

  await assert.rejects(
    () => checkoutSessionService.saveCustomerSignature({ id: s.id, signatureDataUrl: '' }),
    (e) => e.status === 400 && e.code === 'SIGNATURE_REQUIRED',
    'empty signature rejected',
  );
  await assert.rejects(
    () => checkoutSessionService.saveCustomerSignature({ id: 'does-not-exist', signatureDataUrl: sig }),
    (e) => e.status === 404,
    'unknown session rejected',
  );
});

test('resolveCustomerRequest (M1) rejects a past requested return date and applies a valid one', async () => {
  const su = { role: 'SUPER_ADMIN' };
  const seed = await base().catch(() => null) || { cust: { id: ids.customer }, loc: { id: ids.location } };
  const r = await mkReservation(seed, `RES-${SUFFIX}-L`, 'DEALERSHIP_LOANER');
  const now = Date.now();
  const mkLoaner = async (num, requestedReturnAt) => {
    const la = await prisma.loanerAgreement.create({ data: {
      agreementNumber: num, reservationId: r.id, pickupAt: r.pickupAt, returnAt: r.returnAt,
      customerFirstName: 'Sig', customerLastName: 'Test', status: 'ACTIVE',
      portalRequestKind: 'EXTENSION', portalRequestAt: new Date(), requestedReturnAt } });
    ids.loaners.push(la.id);
    return la;
  };

  const past = await mkLoaner(`LA-${SUFFIX}-PAST`, new Date(now - 3600e3));
  await assert.rejects(
    () => dealershipLoanerService.resolveCustomerRequest(su, past.id, { apply: true }),
    (e) => e.statusCode === 400 && /future/i.test(e.message),
    'past requested date rejected',
  );
  await prisma.loanerAgreement.delete({ where: { id: past.id } }).catch(() => {});

  const ok = await mkLoaner(`LA-${SUFFIX}-OK`, new Date(now + 5 * 86400e3));
  const res = await dealershipLoanerService.resolveCustomerRequest(su, ok.id, { apply: true });
  assert.equal(res.applied, true);
  const after = await prisma.reservation.findUnique({ where: { id: r.id } });
  assert.equal(after.returnAt.getTime(), new Date(now + 5 * 86400e3).getTime(), 'reservation.returnAt advanced to the approved date');
});
