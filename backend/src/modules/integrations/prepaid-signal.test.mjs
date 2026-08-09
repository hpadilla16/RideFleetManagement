import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapDetailToRow } from './tl-international/tl-international.service.js';
import { assertPayable } from '../public-booking/authnet-accept-hosted.js';

/**
 * "Already paid" has to reach the code that decides whether to collect.
 *
 * TL International is 100% PREPAID — the aggregator that originated the booking
 * (Expedia, CarTrawler, Carnect, BookingGroup, Stressfree) collected from the
 * customer before they ever reached us. The schema has known this since the
 * field was added: `Reservation.isPrepaid`'s own comment reads "NULL for every
 * other source (TL/Economy = all-prepaid…) → zero behavior change".
 *
 * "Zero behavior change" was true when nothing read the flag. It stopped being
 * true when the public payment path shipped:
 *   - POST /api/public/booking/trips/:tripCode/payment-session
 *   - the lookup falls back to a bare `reservationNumber`, which a promoted
 *     broker reservation has
 *   - computeAmountDue = estimatedTotal − paid, and NOTHING on that path checks
 *     isPrepaid
 *   - promote.js never sets paymentStatus, so imports default to PENDING, which
 *     is payable
 *
 * MEASURED 2026-08-08: `isPrepaid` was NULL on all 854 TL rows, and 54 TL
 * reservations with a future pickup were payable through the public link for
 * $13,187.01 — every one of them already paid to the aggregator.
 *
 * A fact nobody records is a fact nobody can act on. These tests exist so the
 * signal keeps arriving.
 */

test('TL declares itself PREPAID on every mapped row', () => {
  // Not inferred from the externalRef suffix: 853 of 854 TL refs end in "BA",
  // so the suffix identifies TL, not prepayment. The commercial model is the
  // fact, and the connector states it — the same way Advantage states it is
  // 100% pay-on-arrival.
  const row = mapDetailToRow(
    { resno: 'ZE40788386BA', amount: '172.00', pickupdate: '2026-08-13T19:00:00Z' },
    'ZE40788386BA'
  );
  assert.equal(row.isPrepaid, true);
});

test('a malformed detail still returns a row without claiming anything about payment', () => {
  // The early-return path. Claiming "prepaid" on a row we could not read would
  // be inventing a commercial fact; claiming "not prepaid" would arm a charge.
  const row = mapDetailToRow(null, 'ZE-BROKEN');
  assert.equal(row.externalRef, 'ZE-BROKEN');
  assert.equal(row.isPrepaid, undefined);
});

test('TL carries the flag onto the RESERVATION, not just the staging row', () => {
  // Living only on ExternalReservation is what made this invisible: everything
  // that decides whether to collect reads the Reservation.
  const src = readFileSync(
    new URL('./tl-international/tl-international.worker.js', import.meta.url),
    'utf8'
  );
  assert.match(src, /isPrepaid: typeof fresh\.isPrepaid === 'boolean' \? fresh\.isPrepaid : null/);
});

test('the SHARED promoter propagates it, so a new source cannot forget', () => {
  // TL and Advantage each had to remember to copy it across; Flexways and
  // Economy never did. Propagating by default means declaring the model is
  // enough.
  const src = readFileSync(new URL('./booking-source/promote.js', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.\(typeof fresh\.isPrepaid === 'boolean' \? \{ isPrepaid: fresh\.isPrepaid \} : \{\}\)/);
});

test('a source that never sets the flag still creates NO isPrepaid key', () => {
  // The R0 parity contract: the shared promoter must reproduce each source's
  // ORIGINAL writes. An explicit `isPrepaid: null` is the same value in
  // Postgres but breaks that contract — and the contract is the only proof the
  // refactor did not change behaviour. Spread, never a plain null.
  const src = readFileSync(new URL('./booking-source/promote.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*isPrepaid: typeof fresh\.isPrepaid === 'boolean' \? fresh\.isPrepaid : null,\s*$/m);
});

test('Advantage still declares pay-on-arrival — this change did not flip anyone', () => {
  // The mirror case. If propagating the flag by default had inverted a source's
  // meaning, the money would move the other way: charging nobody at the counter.
  const src = readFileSync(
    new URL('./advantage/advantage.worker.js', import.meta.url),
    'utf8'
  );
  assert.match(src, /isPrepaid: false/);
});

/**
 * The gate itself, moved here from `test:public-booking` — which CI does not
 * run. A money guard whose only tests execute on one laptop is the same
 * non-gate as one buried in a red suite. These are pure functions; the move
 * costs nothing and puts them in front of every push.
 */
describe('assertPayable — prepaid bookings', () => {
  // Prepaid bookings are never collectible on the public link.
  //
  // This endpoint is PUBLIC and unauthenticated, and its lookup falls back to a
  // bare `reservationNumber` — which a partner's customer has printed on their
  // voucher. Imports are promoted with the partner's total on `estimatedTotal`
  // and no `paymentStatus`, so they default to PENDING and computeAmountDue
  // offers the FULL amount to somebody who already paid the aggregator.
  //
  // Measured 2026-08-08: TL International is 100% aggregator-prepaid and its
  // isPrepaid was NULL on all 854 rows, leaving 54 future-pickup reservations
  // chargeable here for $13,187.01.
  it('assertPayable REFUSES a prepaid reservation', () => {
  const prepaid = {
    paymentStatus: 'PENDING',
    status: 'CONFIRMED',
    estimatedTotal: 172,
    payments: [],
    isPrepaid: true,
  };
  assert.throws(() => assertPayable(prepaid), (e) => e.code === 'ALREADY_PAID');
});

  it('a pay-on-arrival reservation is still collectible', () => {
  // The mirror. Refusing these would silently stop collection for every
  // partner that bills at the counter — the opposite loss.
  const payAtCounter = {
    paymentStatus: 'PENDING',
    status: 'CONFIRMED',
    estimatedTotal: 172,
    payments: [],
    isPrepaid: false,
  };
  assert.equal(assertPayable(payAtCounter), 172);
});

  it('an UNKNOWN prepaid signal stays payable, and that is deliberate', () => {
  // NULL means "this source never told us", which is not proof of prepayment.
  // Treating it as prepaid would break collection for every source that has
  // not declared its model yet. The connectors are where that gets fixed.
  const unknown = {
    paymentStatus: 'PENDING',
    status: 'CONFIRMED',
    estimatedTotal: 172,
    payments: [],
    isPrepaid: null,
  };
  assert.equal(assertPayable(unknown), 172);
});

  it('the prepaid refusal comes BEFORE the amount is computed', () => {
  // A prepaid reservation with a zero balance must still report ALREADY_PAID
  // for the prepaid reason, not "no balance due" — the operator reading the
  // error needs to know which one it was.
  const prepaidNoBalance = {
    paymentStatus: 'PENDING',
    status: 'CONFIRMED',
    estimatedTotal: 0,
    payments: [],
    isPrepaid: true,
  };
  assert.throws(() => assertPayable(prepaidNoBalance), (e) => /prepaid at booking/i.test(e.message));
});
});
