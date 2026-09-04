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

function fakes({
  agreement = { id: 'ra1', status: 'OPEN' }, existingAgreementRow = null, duplicate = false,
  balanceAfter = 0, checkoutSessionId = 'cs1', resolvedExtra = {},
} = {}) {
  const calls = { mirrored: [], sessionUpdates: [], flags: [], stamps: [] };
  // resolveByReference is stubbed per-test below; extras let a test mark the
  // reference superseded or the session ended.
  fakes.resolved = { kioskSessionId: 'ks1', tenantId: 't1', reservationId: 'res1', superseded: false, sessionLive: true, ...resolvedExtra };
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
    rentalAgreement: { findUnique: async () => ({ balance: balanceAfter }) },
    kioskSession: {
      update: async (args) => { calls.sessionUpdates.push(args); return {}; },
      findUnique: async () => ({ checkoutSessionId }),
    },
  };
  const deps = {
    prisma,
    verifyAndRecord: async () => ({ ok: true, duplicate, amount: 87.25, reference: 'IPOS:TX1' }),
    mirrorToAgreement: async (args) => { calls.mirrored.push(args); return { id: 'rap1' }; },
    flagOrphan: async (args) => { calls.flags.push(args); return { id: 'flag1' }; },
    stampCheckout: async (args) => { calls.stamps.push(args); return {}; },
  };
  return { deps, calls };
}

// resolveByReference hits the real prisma singleton; stub it at the module edge.
import { kioskPaymentIntentService } from '../kiosk/kiosk-payment-intent.service.js';
const realResolve = kioskPaymentIntentService.resolveByReference;
kioskPaymentIntentService.resolveByReference = async () => fakes.resolved;
test.after(() => { kioskPaymentIntentService.resolveByReference = realResolve; });

test('B3: a first-time payment is mirrored onto the agreement ledger', async () => {
  const { deps, calls } = fakes();
  const out = await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(out.paid, true);
  assert.equal(calls.mirrored.length, 1, 'exactly one agreement ledger line');
  assert.equal(calls.mirrored[0].reservation.rentalAgreement.id, 'ra1');
  assert.equal(calls.mirrored[0].payment.reference, 'IPOS:TX1', 'mirrored under the SAME reference the verifier recorded');
});

test('B3: a duplicate return with the ledger already written produces NO second line', async () => {
  const { deps, calls } = fakes({ duplicate: true, existingAgreementRow: { id: 'rap-existing' } });
  const out = await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(out.duplicate, true);
  assert.equal(calls.mirrored.length, 0, 'the ledger already carries this reference; it must not grow');
});

test('A: a RETRY after a failed mirror DOES mirror — the verdict saying "duplicate" is not a trapdoor', async () => {
  // First version gated the mirror on !duplicate. Mirror throws once → guest sees
  // a 500 → every later return is "duplicate" → the agreement stays unpaid forever.
  const { deps, calls } = fakes({ duplicate: true, existingAgreementRow: null });
  const out = await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(out.duplicate, true, 'the verifier still reports duplicate — correctly');
  assert.equal(calls.mirrored.length, 1, 'but the ledger had no row for this reference, so the retry heals it');
});

test('A: a failed mirror raises a staff flag BEFORE re-throwing — staff see it even if a refresh heals it', async () => {
  const { deps, calls } = fakes();
  deps.mirrorToAgreement = async () => { throw new Error('ledger down'); };
  await assert.rejects(() => kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps), /ledger down/);
  assert.equal(calls.flags.length, 1, 'a payment on the reservation but not the agreement is flagged, not merely logged');
  assert.match(calls.flags[0].note, /agreement ledger write failed/);
});

test('C: a payment on a SUPERSEDED link is recorded AND flagged — the guest paid an old QR', async () => {
  const { deps, calls } = fakes({ resolvedExtra: { superseded: true, sessionLive: false } });
  const out = await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(out.paid, true, 'the money is real; it is recorded');
  assert.equal(calls.flags.length, 1, 'and it goes to the staff queue, as the intent service promised');
});

test('C: a payment after the session ENDED is flagged too', async () => {
  const { deps, calls } = fakes({ resolvedExtra: { superseded: false, sessionLive: false } });
  await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(calls.flags.length, 1);
});

test('C: a normal, live, first-time payment is NOT flagged', async () => {
  const { deps, calls } = fakes();
  await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(calls.flags.length, 0, 'the happy path must not spam the staff queue');
});

test('B: when the agreement is SETTLED, the checkout is stamped so the guest can sign', async () => {
  // Without this the tablet was dead after a real payment: sign() refuses until
  // paymentCompletedAt exists and the kiosk polls nothing.
  const { deps, calls } = fakes({ balanceAfter: 0 });
  await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.deepEqual(calls.stamps, [{ id: 'cs1', field: 'paymentCompletedAt' }]);
});

test('B: a PARTIAL payment does NOT unlock signing', async () => {
  const { deps, calls } = fakes({ balanceAfter: 24.75 });
  await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(calls.stamps.length, 0, 'a guest who still owes money must not be able to sign and take the keys');
});

test('B: a failed stamp is logged, not fatal — the money is already recorded', async () => {
  const { deps } = fakes({ balanceAfter: 0 });
  deps.stampCheckout = async () => { throw new Error('checkout locked'); };
  const out = await kioskPaymentLinkService.handlePaymentReturn('Kmtn9zzQATEST01', deps);
  assert.equal(out.paid, true, 'staff can stamp by hand; the payment must not be reported as failed');
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
  assert.equal(calls.stamps.length, 0, 'nothing to settle against, nothing to stamp');
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
