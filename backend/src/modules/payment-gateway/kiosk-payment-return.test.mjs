// B5 Phase 2 — QA BLOCKER 3: the money the guest paid must reach the agreement.
//
// The kiosk quotes RentalAgreement.balance. The shared HPP verifier writes a
// ReservationPayment and nothing else, and that balance is computed ONLY from
// RentalAgreementPayment — so after a real payment the counter still saw the full
// balance and charged the guest again. These pin the mirror, and that it cannot
// produce a second ledger line when the return is hit twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kioskPaymentLinkService } from './kiosk-payment-link.service.js';

function fakes({ agreement = { id: 'ra1', status: 'OPEN' }, existingAgreementRow = null, duplicate = false } = {}) {
  const calls = { mirrored: [], sessionUpdates: [] };
  const prisma = {
    reservation: {
      findUnique: async () => ({
        id: 'res1', tenantId: 't1', reservationNumber: 'R1', rentalAgreement: agreement,
      }),
    },
    reservationPayment: {
      findFirst: async ({ where }) => ({
        id: 'rp1', reservationId: 'res1', reference: where.reference, amount: 87.25,
        method: 'CARD', status: 'PAID', paidAt: new Date(), notes: 'x',
      }),
    },
    rentalAgreementPayment: { findFirst: async () => existingAgreementRow },
    kioskSession: { update: async (args) => { calls.sessionUpdates.push(args); return {}; } },
  };
  const deps = {
    prisma,
    verifyAndRecord: async () => ({ ok: true, duplicate, amount: 87.25, reference: 'IPOS:TX1' }),
    mirrorToAgreement: async (args) => { calls.mirrored.push(args); return { id: 'rap1' }; },
  };
  return { deps, calls };
}

// resolveByReference hits the real prisma singleton; stub it at the module edge.
import { kioskPaymentIntentService } from '../kiosk/kiosk-payment-intent.service.js';
const realResolve = kioskPaymentIntentService.resolveByReference;
kioskPaymentIntentService.resolveByReference = async () => ({
  kioskSessionId: 'ks1', tenantId: 't1', reservationId: 'res1',
});
test.after(() => { kioskPaymentIntentService.resolveByReference = realResolve; });

test('B3: a first-time payment is mirrored onto the agreement ledger', async () => {
  const { deps, calls } = fakes();
  const out = await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(out.paid, true);
  assert.equal(calls.mirrored.length, 1, 'exactly one agreement ledger line');
  assert.equal(calls.mirrored[0].reservation.rentalAgreement.id, 'ra1');
  assert.equal(calls.mirrored[0].payment.reference, 'IPOS:TX1', 'mirrored under the SAME reference the verifier recorded');
});

test('B3: a duplicate return produces NO second ledger line', async () => {
  const { deps, calls } = fakes({ duplicate: true });
  const out = await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(out.duplicate, true);
  assert.equal(calls.mirrored.length, 0, 'the verifier said duplicate; the ledger must not grow');
});

test('B3: an agreement row that already carries this reference is not written twice', async () => {
  // Belt and braces under the duplicate flag: even if the verifier reported a
  // first-time verdict, an existing ledger line with this reference wins.
  const { deps, calls } = fakes({ existingAgreementRow: { id: 'rap-existing' } });
  await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(calls.mirrored.length, 0);
});

test('B3: a reservation with no agreement records on the reservation only, without failing', async () => {
  const { deps, calls } = fakes({ agreement: null });
  const out = await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(out.paid, true, 'the guest still paid; the reservation row is the truth for a reservation with no agreement');
  assert.equal(calls.mirrored.length, 0);
});

test('B3: a failed mirror is LOUD — the double-charge setup must not pass as success', async () => {
  const { deps } = fakes();
  deps.mirrorToAgreement = async () => { throw new Error('ledger down'); };
  await assert.rejects(
    () => kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps),
    /ledger down/,
    'a payment on the reservation but not the agreement is exactly the overcharge this exists to end',
  );
});
