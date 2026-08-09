import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * An imported total must survive somebody LOOKING at the reservation.
 *
 * `syncMandatoryLocationFees` ends by recomputing `Reservation.estimatedTotal`
 * from the charge rows — and it runs inside `getPricing`, which is a READ. So
 * merely opening a reservation's pricing rewrites its total. With no charge
 * rows, `summarizeChargeTotals([])` is 0, and the write destroys whatever was
 * stored.
 *
 * That is the overwhelming majority of this database. Broker and migration
 * reservations are promoted with the partner's agreed total written straight
 * onto `estimatedTotal` and NO charge rows (booking-source/promote.js: "writes
 * ONLY estimatedTotal") — 6,353 of 6,375 pre-pickup reservations.
 *
 * MEASURED IN PROD 2026-08-08, against each reservation's own source
 * `ExternalReservation.totalAmount`:
 *   - 177 of 3,570 promoted pre-pickup reservations had drifted from source
 *   - EVERY ONE of the 177 had zero charge rows — so none of the drift was a
 *     real edit through the charge system
 *   - 12 sat at exactly 0.00 against a source that says money is owed
 *     ($1,361.16), spanning 2026-05-25 to 2026-08-07 — still happening
 *
 * Scope, stated honestly: check-in does NOT bill from `estimatedTotal` (it
 * synthesizes `dailyRate × days`), so this is a reporting and display defect,
 * not a direct billing one. It still means every screen, export and revenue
 * report showing these reservations is wrong.
 */

const SRC = readFileSync(
  new URL('./reservation-pricing.service.js', import.meta.url),
  'utf8'
);

/** The tail of syncMandatoryLocationFees, where the write lives. */
function feeSyncTail() {
  const start = SRC.indexOf('async function syncMandatoryLocationFees');
  assert.ok(start > 0, 'syncMandatoryLocationFees not found — did it move?');
  const end = SRC.indexOf('\nexport const reservationPricingService', start);
  return SRC.slice(start, end > 0 ? end : undefined);
}

test('the estimatedTotal write is GUARDED, not unconditional', () => {
  // The whole defect in one line: a read that writes money with no condition.
  const tail = feeSyncTail();
  const write = tail.indexOf('data: { estimatedTotal: summarizeChargeTotals');
  assert.ok(write > 0, 'the estimatedTotal write is gone — did this move?');
  const guard = tail.indexOf('if (pricedBefore.length > 0)');
  assert.ok(guard > 0, 'the write must be behind a guard');
  assert.ok(guard < write, 'the guard must come BEFORE the write');
});

test('the guard counts rows this sync did NOT write, selected or not', () => {
  // The distinction that makes this correct rather than merely safe:
  //   no rows at all  → never priced here → leave the imported total alone
  //   rows exist, none selected → an admin voided everything → 0 IS the total
  // Guarding on `refreshedCharges.length` instead would freeze a fully-voided
  // reservation at its old total, which is a different wrong answer.
  const tail = feeSyncTail();
  // No `selected` filter on this lookup — that is the whole point.
  assert.match(tail, /priorRows = await tx\.reservationCharge\.findMany/);
  // And it must EXCLUDE the rows the syncs in getPricing create themselves:
  // counting a MANDATORY_FEE this function just wrote made the guard one read
  // behind — safe on call #1, overwritten on call #2 (measured 412.50 → 4.50).
  assert.match(tail, /SYNC_OWNED_CHARGE_SOURCES\.has/);
  assert.doesNotMatch(tail, /if \(refreshedCharges\.length > 0\)/);
  // count() would be the obvious call and it BREAKS the fake-db fixtures that
  // only implement the methods this path already used (three kiosk tests fell
  // through to the real client and died against a database they never needed).
  assert.doesNotMatch(tail, /reservationCharge\.count\(/);
});

test('the read happens BEFORE this sync creates any fee row', () => {
  // The defect the first fix shipped: reading after the loop let the function's
  // own create satisfy its own guard, so a location with ONE mandatory fee
  // turned an imported $412.50 into $4.50 — non-zero, so it never looked wrong.
  const tail = feeSyncTail();
  const read = tail.indexOf('priorRows = await');
  const create = tail.indexOf('tx.reservationCharge.create');
  const write = tail.indexOf('data: { estimatedTotal');
  assert.ok(read > 0 && create > 0 && write > 0);
  assert.ok(read < create, 'the guard must read BEFORE any fee row is created');
  assert.ok(create < write, 'sanity: fees are created before the total is written');
});

test('the read is taken inside the SAME transaction as the write', () => {
  // Reading it outside would let a concurrent charge delete land between the
  // check and the write — the guard would pass and the zero would still land.
  const tail = feeSyncTail();
  const idx = tail.indexOf('priorRows = await');
  const txStart = tail.indexOf('prisma.$transaction');
  assert.ok(txStart > 0 && idx > txStart, 'the count must be inside the transaction');
  assert.match(tail.slice(idx, idx + 60), /await tx\./);
});

test('the reasoning is written down where the next reader will be', () => {
  // This looks like a redundant guard until you know it protects 6,353
  // reservations whose total exists nowhere else. Someone WILL be tempted to
  // "simplify" it back.
  const tail = feeSyncTail();
  assert.match(tail, /NEVER OVERWRITE AN IMPORTED TOTAL WITH ZERO/);
  assert.match(tail, /promote\.js|writes ONLY estimatedTotal/);
});

// The behavioural cases live in imported-total-behavioral.test.mjs, driving the
// REAL getPricing. They used to live here as a `decide()` helper that
// re-implemented the guard — deleting the guard from the service left them all
// green, so they proved only that I could restate my own rule, and they missed
// the fee-ordering defect entirely.
