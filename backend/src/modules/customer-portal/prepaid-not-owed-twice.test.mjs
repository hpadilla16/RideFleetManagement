import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decideAmountDue } from './amount-due.js';

/**
 * What a customer owes right now, driven through the REAL decision.
 *
 * The first version of this file restated the rule in a local `amountDue()`
 * helper. QA named the input where the two diverged —
 * `{prepaid:true, paid:45, agreementBalance:0, agreementTotal:45}`: the mirror
 * said 0, the function said 45 — and five of eight cases would have passed
 * with the production code deleted. That is the fourth time in this arc a test
 * validated a copy instead of the thing.
 *
 * The decision now lives in `amount-due.js` precisely so this file can call it:
 * importing customer-portal.routes.js hangs on its transitive imports.
 */

test('a settled agreement is not a bill — even on its OWN ledger', () => {
  // `paid` counts RESERVATION payments; settled-ness lives on the agreement.
  // Three live writers create a RentalAgreementPayment with no reservation
  // mirror (checkout wizard, auto-applied credit, agent manual entry), so
  // guarding on `paid` alone re-opened the same double charge through the
  // other book: measured $300.00 on paidAmount 300 / balance 0.
  assert.equal(
    decideAmountDue({ agreement: { balance: 0, total: 300, paidAmount: 300 }, reservation: {}, breakdown: { total: 0 }, paid: 0 }),
    0
  );
});

test('a HALF-paid agreement is not re-presented in full', () => {
  // Over-charges by whatever was already taken.
  assert.equal(
    decideAmountDue({ agreement: { balance: 0, total: 300, paidAmount: 150 }, reservation: {}, breakdown: { total: 0 }, paid: 0 }),
    0
  );
});

test('a partial payment with a live balance returns the balance, not the total', () => {
  assert.equal(
    decideAmountDue({ agreement: { balance: 150, total: 300, paidAmount: 150 }, reservation: {}, breakdown: { total: 0 }, paid: 0 }),
    150
  );
});

test('a settled agreement is not a bill', () => {
  // MEASURED BEFORE THE FIX: balance 0, total 45, already paid → returned 45
  // again, with a live Pay Now button. `balance` is the authoritative figure;
  // falling through to `total` re-presents a settled agreement.
  assert.equal(
    decideAmountDue({ agreement: { balance: 0, total: 45 }, reservation: { isPrepaid: true }, breakdown: { total: 45 }, paid: 45 }),
    0
  );
});

test('the same shape on a NON-prepaid booking is also not re-billed', () => {
  // The pre-existing half: a fully-paid $330 reservation used to return $330.
  assert.equal(
    decideAmountDue({ agreement: { balance: 0, total: 330 }, reservation: { isPrepaid: false }, breakdown: { total: 330 }, paid: 330 }),
    0
  );
});

test('an agreement with no balance asks for nothing, whatever its total says', () => {
  // This case used to expect 120, defending the `total` fallback on the theory
  // that an agreement whose balance was never populated would otherwise go
  // uncollected. MEASURED on prod 2026-08-09: 0 of 1,298 agreements have that
  // shape (balance 0, total > 0, paidAmount 0). The fallback protected nobody
  // and re-billed people who had paid.
  assert.equal(
    decideAmountDue({ agreement: { balance: 0, total: 120 }, reservation: {}, breakdown: { total: 0 }, paid: 0 }),
    0
  );
});

test('a counter payment that never mirrored down does NOT re-bill the charge sheet', () => {
  // Z1/Z2, the bug this rule closes. The agreement is settled (balance 0,
  // paidAmount 604.63) but the reservation's own books still show unpaid charge
  // rows, because three live writers create a RentalAgreementPayment with no
  // ReservationPayment mirror. `reservationOutstanding` returned FIRST, so the
  // portal asked a paid customer for the full sheet again.
  //
  // Shape taken from prod RES-802488. MEASURED across prod with the portal's
  // OWN deposit filter: 19 settled agreements would ask for $1,135.60 today;
  // 16 of them already carry a counter payment.
  assert.equal(
    decideAmountDue({
      agreement: { balance: 0, total: 104.63, paidAmount: 104.63 },
      reservation: {},
      breakdown: { total: 104.63 },
      paid: 0,
    }),
    0
  );
});

test('an agreement with a live balance still collects it', () => {
  // The mirror of the case above — the rule must not stop collection, only
  // stop the second opinion. Real money still moves through `balance`.
  assert.equal(
    decideAmountDue({
      agreement: { balance: 89.5, total: 300, paidAmount: 210.5 },
      reservation: {},
      breakdown: { total: 300 },
      paid: 0,
    }),
    89.5
  );
});

test('a deposit does not resurrect a bill once the agreement exists', () => {
  // By check-out the agreement has absorbed the deposit. Consulting the
  // pre-check-in snapshot here would re-ask for a hold the counter settled.
  assert.equal(
    decideAmountDue({
      agreement: { balance: 0, total: 300, paidAmount: 300 },
      reservation: { pricingSnapshot: { depositRequired: true, depositAmountDue: 250 } },
      breakdown: { total: 300 },
      paid: 0,
    }),
    0
  );
});

test('a prepaid customer still owes what they bought at the counter', () => {
  // The case the first attempt broke: zeroing `est` for prepaid turned a $45
  // portal-sold insurance line into $0.00 due and hid the Pay Now button,
  // making it uncollectible until check-in.
  assert.equal(
    decideAmountDue({ agreement: null, reservation: { isPrepaid: true }, breakdown: { total: 45 }, paid: 0 }),
    45
  );
});

test('a prepaid import with nothing sold owes nothing', () => {
  // The real broker shape: promote.js writes the partner's total and NO charge
  // rows, so the breakdown is empty. The partner total never reaches this
  // arithmetic — `??` does not fall through on 0.
  assert.equal(
    decideAmountDue({ agreement: null, reservation: { isPrepaid: true, estimatedTotal: 412.5 }, breakdown: { total: 0 }, paid: 0 }),
    0
  );
});

test('and neither does it for an import whose flag was never set', () => {
  // Flexways sends no prepaid flag at all. The result must not depend on it
  // here — this path reads charge rows, not the stored total.
  assert.equal(
    decideAmountDue({ agreement: null, reservation: { isPrepaid: null, estimatedTotal: 412.5 }, breakdown: { total: 0 }, paid: 0 }),
    0
  );
});

test('pay-at-destination collects the full rental', () => {
  // The mirror. 1,851 Economy reservations are explicitly pay-at-counter;
  // treating them as prepaid would stop collecting on every one.
  assert.equal(
    decideAmountDue({ agreement: null, reservation: { isPrepaid: false }, breakdown: { total: 412.5 }, paid: 0 }),
    412.5
  );
});

test('a partial payment nets out', () => {
  assert.equal(
    decideAmountDue({ agreement: null, reservation: { isPrepaid: false }, breakdown: { total: 412.5 }, paid: 100 }),
    312.5
  );
});

test('a security deposit is still collected from a prepaid customer', () => {
  // A hold is not the rental. Measured unchanged at $250.
  assert.equal(
    decideAmountDue({
      agreement: null,
      reservation: { isPrepaid: true, pricingSnapshot: { depositRequired: true, depositAmountDue: 250 } },
      breakdown: { total: 0 }, paid: 0,
    }),
    250
  );
});

test('an outstanding balance always wins over the total', () => {
  assert.equal(
    decideAmountDue({ agreement: { balance: 45, total: 412.5 }, reservation: { isPrepaid: true }, breakdown: { total: 45 }, paid: 0 }),
    45
  );
});

// ── Wiring ──────────────────────────────────────────────────────────────────
const SRC = readFileSync(new URL('./customer-portal.routes.js', import.meta.url), 'utf8');

test('the route delegates to the real decision instead of restating it', () => {
  assert.match(SRC, /return decideAmountDue\(\{ agreement: latestAgreement/);
  assert.match(SRC, /from '\.\/amount-due\.js'/);
});

test('nothing due is refused on the two routes that MOVE money', () => {
  // The public path refuses this (assertPayable → ALREADY_PAID); the portal
  // floored it to $0.50 and minted a real hosted page for a customer who owed
  // nothing.
  const hits = SRC.match(/Nothing is due on this reservation/g) || [];
  assert.equal(hits.length, 2, 'create-session and confirm — not the page loader');
});

test('the refusal is NOT on the GET that renders the page', () => {
  // The first version put it here too, and its own assertion (hits === 3) then
  // pinned the regression in place. That GET moves no money: a 409 collapses
  // the payment page to an error banner for every settled reservation, loses
  // the signed-agreement download and the receipt, and breaks the
  // post-checkout poller that reads amountDue to notice the payment landed.
  // It also hid the prepaid copy from the only population it was written for,
  // since prepaid bookings sit at 0 by construction.
  const i = SRC.indexOf("customerPortalRouter.get('/payment/:token'");
  assert.ok(i > 0, 'payment page route not found — did it move?');
  const handler = SRC.slice(i, SRC.indexOf('customerPortalRouter.', i + 40));
  assert.doesNotMatch(handler, /Nothing is due on this reservation/);
  assert.match(handler, /NO REFUSAL HERE/);
});

test('the portal is told, so it can stop showing a figure', () => {
  assert.match(SRC, /isPrepaid: reservation\.isPrepaid \?\? null/);
});
