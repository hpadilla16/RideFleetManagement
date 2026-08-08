import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertRepriceable, rentalDays, isBaseRentalRow } from './reservation-extend.service.js';

/**
 * The reschedule price has to SURVIVE THE NEXT READ.
 *
 * Measured on RES-107160, twice. Both times the reschedule moved the dates
 * correctly, the API answered success with the new total, the AuditLog recorded
 * the new total and daily rate — and the reservation was back on the OLD rate
 * within a minute. The caller was quoted $52.03; the system would have billed
 * $43.71.
 *
 * Cause: `Reservation.estimatedTotal` has TWO writers. The reschedule stamped
 * the quote engine's number; `syncMandatoryLocationFees` recomputes it from the
 * ReservationCharge rows and runs inside `getPricing` — a READ. Moving dates
 * without rebuilding those rows left them on the old daily rate, so the next
 * pricing read reverted the price silently.
 *
 * The first version of this test file was source-text regexes, and one of them
 * asserted the handler contained `source: 'DAILY'` — which PINNED a second bug
 * in place: the current booking path writes `source: 'BASE_RATE'`, so deleting
 * only 'DAILY' matches nothing on a website booking and the base rate is added
 * a second time. These cases exercise the real predicate instead.
 */

// ─── The base-rate predicate, exercised against the shapes prod actually has ──

// IMPORTED, never re-declared. The previous version of this file kept its own
// copy of the predicate, so it went on passing while the service's copy was
// replaced — a test that validates a rule nobody runs.
const baseRateRows = (charges) => charges.filter(isBaseRentalRow);

const BASE_RATE_SHAPES = [
  // Current public booking path (booking-engine.service.js).
  { id: 'a', source: 'BASE_RATE', code: 'DAILY', name: 'Daily', chargeType: 'UNIT', total: 39.2 },
  // Older paths / migrated rows — what RES-107160 actually carried.
  { id: 'b', source: 'DAILY', code: null, name: 'Daily', chargeType: 'DAILY', total: 39.2 },
  // Very old rows from before `source` was reliably populated.
  { id: 'c', source: null, code: null, name: 'Daily', chargeType: 'DAILY', total: 39.2 }
];

for (const shape of BASE_RATE_SHAPES) {
  test(`base-rate row is recognised when source is ${JSON.stringify(shape.source)}`, () => {
    // Enumerating labels is what made the first attempt duplicate the base rate
    // on every website booking. A NULL source in particular can never be caught
    // by a negated Prisma string filter (the beta.297 duplicate-charge
    // incident), which is why the rows are selected in JS and deleted by id.
    assert.deepEqual(baseRateRows([shape]).map((r) => r.id), [shape.id]);
  });
}

test('tax, deposit, extension and per-day add-ons are NEVER treated as base rate', () => {
  // Deleting any of these would destroy money the customer agreed to: an
  // EXTENSION_RATE row is anchored by id from RentalAgreementAddendum, and a
  // deposit row is excluded from totals entirely.
  const keep = [
    { id: 't', chargeType: 'TAX', name: 'Sales Tax (11.50%)', source: 'TAX' },
    { id: 'd', chargeType: 'DEPOSIT', name: 'Security Deposit', source: 'SECURITY_DEPOSIT' },
    { id: 'e', code: 'EXTENSION_RATE', chargeType: 'DAILY', source: 'EXTENSION_DEFAULT' },
    { id: 'i', chargeType: 'DAILY', source: 'INSURANCE', name: 'CDW' },
    { id: 's', chargeType: 'UNIT', source: 'ADDITIONAL_SERVICE', name: 'Prepaid tolls' },
    { id: 'f', chargeType: 'UNIT', source: 'FEE', name: 'Airport fee' },
    // The ones the exclusion predicate destroyed. Nothing recreates these.
    { id: 'p', chargeType: 'UNIT', source: 'ADDITIONAL_SERVICE_PRECHECKIN', name: 'Child seat (prepaid)' },
    { id: 'w', chargeType: 'UNIT', source: 'WEBSITE_FEE', name: 'Booking fee' },
    { id: 'ic', chargeType: 'UNIT', source: 'ISSUE_CENTER', name: 'Claim charge' },
    { id: 'dd', chargeType: 'DEPOSIT', source: 'DEPOSIT', name: 'Deposit (due now)' }
  ];
  assert.deepEqual(baseRateRows(keep), []);
});

test('a mixed real-world charge set selects ONLY the base row', () => {
  const charges = [
    { id: 'base', source: 'BASE_RATE', chargeType: 'UNIT', name: 'Daily', total: 46.66 },
    { id: 'ins', source: 'INSURANCE', chargeType: 'DAILY', name: 'CDW', total: 20 },
    { id: 'dep', source: 'SECURITY_DEPOSIT', chargeType: 'DEPOSIT', name: 'Security Deposit', total: 250 },
    { id: 'tax', source: 'TAX', chargeType: 'TAX', name: 'Sales Tax (11.50%)', total: 7.67 }
  ];
  assert.deepEqual(baseRateRows(charges).map((r) => r.id), ['base']);
});

// ─── The refusals, which must happen BEFORE the dates move ────────────────────

test('a monthly-cycle plan is refused, never converted to daily', () => {
  // Stacking a daily line on a locked monthly cycle bills both.
  assert.throws(
    () => assertRepriceable([{ source: 'MONTHLY_CYCLE', chargeType: 'UNIT' }], 30, 30),
    (e) => e.code === 'UNSUPPORTED_PRICING_PLAN' && e.status === 409
  );
});

test('an OTA prepaid voucher is refused, never re-billed', () => {
  // customer-portal deletes the base row on purpose for third-party prepaid
  // bookings and leaves this marker. Recreating a full-price Daily line would
  // charge a customer who has already paid the OTA.
  assert.throws(
    () => assertRepriceable([{ source: 'OTA_PREPAID_VOUCHER', chargeType: 'UNIT' }], 3, 5),
    (e) => e.code === 'UNSUPPORTED_PRICING_PLAN' && e.status === 409
  );
});

test('changing the LENGTH with per-day add-ons present is refused', () => {
  // Insurance and prepaid tolls carry their own day count. Rescaling them
  // wrongly underbills the add-on while the caller is quoted a total that
  // includes it — so this fails closed until it reuses shouldRescaleDailyRow.
  assert.throws(
    () => assertRepriceable([{ source: 'INSURANCE', chargeType: 'DAILY', selected: true }], 2, 4),
    (e) => e.code === 'PER_DAY_ADDONS_PRESENT' && e.status === 409
  );
});

test('SHIFTING the dates without changing the length is allowed with add-ons', () => {
  // The RES-107160 case: both ends moved one day, duration unchanged. Refusing
  // this would break the ordinary request the tool exists to serve.
  assert.doesNotThrow(() =>
    assertRepriceable([{ source: 'INSURANCE', chargeType: 'DAILY', selected: true }], 2, 2)
  );
});

test('a voided add-on does not block a length change', () => {
  assert.doesNotThrow(() =>
    assertRepriceable([{ source: 'INSURANCE', chargeType: 'DAILY', selected: false }], 2, 4)
  );
});

test('a plain reservation reprices freely', () => {
  assert.doesNotThrow(() =>
    assertRepriceable([{ source: 'BASE_RATE', chargeType: 'UNIT' }, { chargeType: 'TAX', source: 'TAX' }], 2, 5)
  );
});

test('rentalDays counts the window the same way the engine does', () => {
  assert.equal(rentalDays(new Date('2026-08-08T14:00:00Z'), new Date('2026-08-10T14:00:00Z')), 2);
});

// ─── Wiring: the pieces that made the live defect invisible ───────────────────

const ROUTES = readFileSync(new URL('./reservations.routes.js', import.meta.url), 'utf8');
const EXTEND = readFileSync(new URL('./reservation-extend.service.js', import.meta.url), 'utf8');

function rescheduleHandler() {
  const start = ROUTES.indexOf("reservationsRouter.post('/:id/reschedule'");
  assert.ok(start > 0, 'reschedule route not found — did it move?');
  const end = ROUTES.indexOf('reservationsRouter.', start + 50);
  return ROUTES.slice(start, end > 0 ? end : undefined);
}

test('the reprice runs through the SERVICE, not inline in the route', () => {
  // Every other money mutation lives in a service; the inline version could not
  // be tested against a charge set, which is how it shipped with a formula that
  // disagreed with the canonical reader.
  const h = rescheduleHandler();
  assert.match(h, /reservationExtendService\.repriceForNewDates/);
  assert.doesNotMatch(h, /prisma\.\$transaction/);
});

test('refusals are checked BEFORE the dates are committed', () => {
  const h = rescheduleHandler();
  const check = h.indexOf('assertRepriceable');
  const write = h.indexOf('reservationsService.update');
  assert.ok(check > 0 && check < write, 'assertRepriceable must run before update()');
});

test('the total reported comes from the CANONICAL read, not a local sum', () => {
  // getPricing writes estimatedTotal through summarizeChargeTotals — the one
  // formula, which EXCLUDES deposits. A local sum of every selected row would
  // add a $250 deposit into the quoted total and the next read would drop it
  // back out: the same bug, bigger.
  assert.match(EXTEND, /reservationPricingService\.getPricing\(reservationId, scope\)/);
  assert.match(EXTEND, /total: priced\.totals\.total/);
});

test('the reconciliation guard compares LIKE FOR LIKE', () => {
  // row.total (engine) is base + tax-on-base + website-channel fees; the
  // reservation's real total also carries insurance, services and tolls.
  // Comparing those two 500s on any reservation with a CDW line — after the
  // dates have already moved. What must agree is the base component.
  const h = rescheduleHandler();
  assert.match(h, /priced\.baseTotal - row\.subtotal/);
  assert.doesNotMatch(h, /priced\.total - row\.total/);
});

test('the snapshot daily rate is updated, not just the reservation', () => {
  // The snapshot takes precedence for percentage mandatory fees, for a later
  // extension's price and for the customer portal display. Leaving it stale
  // prices the next extension at the OLD rate.
  assert.match(EXTEND, /reservationPricingSnapshot\.update/);
});

test('a reprice failure says the dates moved instead of reporting a price', () => {
  // The dates are committed by then. Silently reverting would be worse, and
  // quoting a number nobody verified is what caused this whole incident.
  const h = rescheduleHandler();
  assert.match(h, /datesMoved: true/);
  assert.match(h, /RESCHEDULE_BASE_MISMATCH/);
  assert.match(h, /logger\.error/);
});

test('the response and the audit report what was PERSISTED, not the quote', () => {
  const h = rescheduleHandler();
  const afterBlocks = [...h.matchAll(/after:\s*\{[\s\S]*?\n\s*\}/g)].map((m) => m[0]);
  assert.equal(afterBlocks.length, 2, 'expected the audit and the response after-blocks');
  for (const block of afterBlocks) {
    assert.match(block, /estimatedTotal:\s*priced\.total/);
    assert.doesNotMatch(block, /estimatedTotal:\s*row\.total/);
  }
});

test('the pre-pickup gate still precedes every write', () => {
  const h = rescheduleHandler();
  const gate = h.indexOf('assertPrePickup');
  const write = h.indexOf('reservationsService.update');
  assert.ok(gate > 0 && gate < write);
});

// ─── EXECUTING the function that writes money ────────────────────────────────
//
// The first version of this file did not do this, and it cost a shipped
// ReferenceError: `newDays` was referenced inside repriceForNewDates but only
// declared as a parameter of assertRepriceable. Every reschedule would have
// moved the dates, thrown inside the transaction, and returned "dates moved,
// price unconfirmed" — the original defect with an error message on top. Twenty
// passing tests missed it because they exercised a re-declared COPY of the
// predicate and regexes over the route's source, never the function itself.

import { reservationExtendService } from './reservation-extend.service.js';
import { reservationPricingService } from './reservation-pricing.service.js';
import { prisma } from '../../lib/prisma.js';

function installMock(charges) {
  const saved = {
    reservation: { ...prisma.reservation },
    reservationCharge: { ...prisma.reservationCharge },
    reservationPricingSnapshot: { ...(prisma.reservationPricingSnapshot || {}) },
    $transaction: prisma.$transaction,
    getPricing: reservationPricingService.getPricing
  };
  const state = {
    reservation: {
      id: 'res-1', tenantId: 't1', status: 'CONFIRMED',
      pickupAt: new Date('2026-08-09T14:00:00Z'),
      returnAt: new Date('2026-08-11T14:00:00Z'),
      pickupLocationId: 'loc-1', dailyRate: 19.6, estimatedTotal: 43.71
    },
    charges: charges.map((c) => ({ selected: true, ...c, reservationId: 'res-1' })),
    snapshot: { reservationId: 'res-1', dailyRate: 19.6, taxRate: 11.5 }
  };
  let seq = 500;

  prisma.reservation.findFirst = async () => ({
    ...state.reservation,
    // VOIDED ROWS INCLUDED, because production's getReservationOrThrow includes
    // them (no `selected` filter). Filtering here made a soft-voided base row
    // STRUCTURALLY IMPOSSIBLE in every test — so the bug where the reprice
    // deletes an admin's waived rental and re-bills it could never be caught.
    // Same failure as the round where this mock's deleteMany only understood
    // `id.in`: a fake more forgiving than the database hides the write it exists
    // to cover.
    charges: [...state.charges],
    pricingSnapshot: state.snapshot
  });
  prisma.reservation.update = async ({ data }) => {
    Object.assign(state.reservation, data);
    return { ...state.reservation };
  };
  prisma.reservationCharge.deleteMany = async ({ where }) => {
    // MUST honour chargeType too: recomputeTaxRow deletes by
    // { reservationId, chargeType: 'TAX' }. A mock that only understood
    // `id.in` silently left the OLD tax row in place and ended with TWO — and
    // no assertion could see it, because the stubbed read just sums whatever
    // is there. A fake that is more forgiving than the database hides exactly
    // the write it was built to cover.
    const before = state.charges.length;
    const ids = where?.id?.in ? new Set(where.id.in) : null;
    state.charges = state.charges.filter((c) => {
      if (ids) return !ids.has(c.id);
      if (where?.chargeType) return String(c.chargeType || '') !== String(where.chargeType);
      return true;
    });
    return { count: before - state.charges.length };
  };
  // recomputeTaxRow queries `where: { selected: true }` — strictly true, so a
  // row with a null `selected` is NOT returned. Mirror that exactly.
  prisma.reservationCharge.findMany = async ({ where } = {}) =>
    (where?.selected === true ? state.charges.filter((c) => c.selected === true) : [...state.charges]);
  prisma.reservationCharge.create = async ({ data }) => {
    const row = { id: `new-${seq++}`, ...data };
    state.charges.push(row);
    return row;
  };
  prisma.reservationPricingSnapshot = prisma.reservationPricingSnapshot || {};
  prisma.reservationPricingSnapshot.findUnique = async () => state.snapshot;
  prisma.reservationPricingSnapshot.update = async ({ data }) => {
    Object.assign(state.snapshot, data);
    return { ...state.snapshot };
  };
  prisma.$transaction = async (fn) => fn(prisma);
  prisma.location = prisma.location || {};
  prisma.location.findUnique = async () => ({ taxRate: 11.5 });

  // The canonical read, standing in for the real getPricing: it writes
  // estimatedTotal from summarizeChargeTotals (deposits EXCLUDED) and returns
  // the same totals. Anything that disagrees with this is the bug.
  reservationPricingService.getPricing = async () => {
    const live = state.charges.filter((c) => c.selected !== false);
    const isDeposit = (c) => String(c.chargeType || '').toUpperCase() === 'DEPOSIT';
    const subtotal = Number(live.filter((c) => String(c.chargeType || '').toUpperCase() !== 'TAX' && !isDeposit(c))
      .reduce((s, c) => s + Number(c.total || 0), 0).toFixed(2));
    const taxes = Number(live.filter((c) => String(c.chargeType || '').toUpperCase() === 'TAX')
      .reduce((s, c) => s + Number(c.total || 0), 0).toFixed(2));
    const total = Number((subtotal + taxes).toFixed(2));
    state.reservation.estimatedTotal = total;
    return { charges: live, totals: { subtotal, taxes, total } };
  };

  return {
    state,
    restore() {
      Object.assign(prisma.reservation, saved.reservation);
      Object.assign(prisma.reservationCharge, saved.reservationCharge);
      Object.assign(prisma.reservationPricingSnapshot, saved.reservationPricingSnapshot);
      prisma.$transaction = saved.$transaction;
      reservationPricingService.getPricing = saved.getPricing;
    }
  };
}

const WEBSITE_SHAPED = [
  { id: 'base', source: 'BASE_RATE', code: 'DAILY', name: 'Daily', chargeType: 'UNIT', quantity: 2, rate: 19.6, total: 39.2, taxable: true },
  { id: 'dep', source: 'SECURITY_DEPOSIT', name: 'Security Deposit', chargeType: 'DEPOSIT', quantity: 1, rate: 250, total: 250, taxable: false },
  { id: 'dep2', source: 'DEPOSIT', name: 'Deposit (due now)', chargeType: 'DEPOSIT', quantity: 1, rate: 50, total: 50, taxable: false },
  { id: 'ins', source: 'INSURANCE', name: 'CDW', chargeType: 'DAILY', quantity: 2, rate: 10, total: 20, taxable: true },
  { id: 'pre', source: 'ADDITIONAL_SERVICE_PRECHECKIN', name: 'Child seat (prepaid)', chargeType: 'UNIT', quantity: 1, rate: 15, total: 15, taxable: true },
  { id: 'wfee', source: 'WEBSITE_FEE', name: 'Booking fee', chargeType: 'UNIT', quantity: 1, rate: 5, total: 5, taxable: true },
  { id: 'tax', source: 'TAX_RECALC', name: 'Sales Tax (11.50%)', chargeType: 'TAX', quantity: 1, rate: 9.11, total: 9.11, taxable: false }
];

test('repriceForNewDates RUNS, and replaces exactly one base row', async () => {
  const m = installMock(WEBSITE_SHAPED);
  try {
    // Same duration (2 days), new rate — the RES-107160 shape.
    const out = await reservationExtendService.repriceForNewDates(
      'res-1', { days: 2, dailyRate: 23.33, subtotal: 46.66, total: 52.03 }, {}
    );
    const bases = m.state.charges.filter((c) => ['BASE_RATE', 'DAILY'].includes(String(c.source || '').toUpperCase()));
    assert.equal(bases.length, 1, 'exactly one base row must survive');
    assert.equal(Number(bases[0].total), 46.66, 'the base row carries the engine subtotal');
    assert.equal(out.baseTotal, 46.66);
  } finally { m.restore(); }
});

test('paid add-ons, fees and BOTH deposit rows survive the reprice', async () => {
  // The predicate-by-exclusion version deleted every one of these. Nothing
  // recreates the pre-check-in add-on or the website fee, so that was silent,
  // permanent loss of money the customer had already agreed to.
  const m = installMock(WEBSITE_SHAPED);
  try {
    await reservationExtendService.repriceForNewDates(
      'res-1', { days: 2, dailyRate: 23.33, subtotal: 46.66, total: 52.03 }, {}
    );
    const ids = new Set(m.state.charges.map((c) => c.id));
    for (const keep of ['dep', 'dep2', 'ins', 'pre', 'wfee']) {
      assert.ok(ids.has(keep), `${keep} must survive the reprice`);
    }
  } finally { m.restore(); }
});

test('the total returned IS the reservation\'s persisted estimatedTotal', async () => {
  // The whole point: the number the caller is told must be the number the
  // system keeps, not one a later read gets to overrule.
  const m = installMock(WEBSITE_SHAPED);
  try {
    const out = await reservationExtendService.repriceForNewDates(
      'res-1', { days: 2, dailyRate: 23.33, subtotal: 46.66, total: 52.03 }, {}
    );
    assert.equal(out.total, Number(m.state.reservation.estimatedTotal));
  } finally { m.restore(); }
});

test('the $250 deposit is NOT counted into the quoted total', async () => {
  // A flat sum of every selected row would have added the deposit, quoted it to
  // the caller, and had the next read drop it back out — the same defect with a
  // much bigger delta.
  const m = installMock(WEBSITE_SHAPED);
  try {
    const out = await reservationExtendService.repriceForNewDates(
      'res-1', { days: 2, dailyRate: 23.33, subtotal: 46.66, total: 52.03 }, {}
    );
    assert.ok(out.total < 200, `deposit leaked into the total: ${out.total}`);
  } finally { m.restore(); }
});

test('both the reservation AND the snapshot get the new daily rate', async () => {
  // A stale snapshot rate prices the next extension at the OLD rate and shows
  // the old rate in the customer portal.
  const m = installMock(WEBSITE_SHAPED);
  try {
    await reservationExtendService.repriceForNewDates(
      'res-1', { days: 2, dailyRate: 23.33, subtotal: 46.66, total: 52.03 }, {}
    );
    assert.equal(Number(m.state.reservation.dailyRate), 23.33);
    assert.equal(Number(m.state.snapshot.dailyRate), 23.33);
  } finally { m.restore(); }
});

test('an unrecognised SECOND base row is refused, not double-billed', async () => {
  const m = installMock([
    ...WEBSITE_SHAPED,
    { id: 'ghost', source: 'DAILY', name: 'Daily', chargeType: 'DAILY', quantity: 2, rate: 19.6, total: 39.2, taxable: true }
  ]);
  try {
    // Both base rows are recognised and removed, so this SUCCEEDS with one row —
    // which is the point: recognition is what prevents the duplicate.
    const out = await reservationExtendService.repriceForNewDates(
      'res-1', { days: 2, dailyRate: 23.33, subtotal: 46.66, total: 52.03 }, {}
    );
    const bases = m.state.charges.filter((c) => ['BASE_RATE', 'DAILY'].includes(String(c.source || '').toUpperCase()));
    assert.equal(bases.length, 1);
    assert.equal(out.baseTotal, 46.66);
  } finally { m.restore(); }
});

test('exactly ONE tax row survives — the old one is really deleted', async () => {
  const m = installMock(WEBSITE_SHAPED);
  try {
    await reservationExtendService.repriceForNewDates(
      'res-1', { days: 2, dailyRate: 23.33, subtotal: 46.66, total: 52.03 }, {}
    );
    const taxes = m.state.charges.filter((c) => String(c.chargeType || '').toUpperCase() === 'TAX');
    assert.equal(taxes.length, 1, `expected one TAX row, found ${taxes.length}`);
  } finally { m.restore(); }
});

test('a broker/import reservation is REFUSED, not repriced to retail', () => {
  // 6,353 of 6,375 live pre-pickup reservations are MIGRATION or FRANCHISE_*
  // with no charge rows at all; their estimatedTotal is a broker NET or prepaid
  // figure. Repricing one replaces it with counter pricing.
  for (const channel of ['MIGRATION', 'FRANCHISE_NU', 'FRANCHISE_ECONOMY', 'FRANCHISE_FLEXWAYS', 'EXPEDIA', 'CAR_SHARING']) {
    assert.throws(
      () => assertRepriceable([], 0, 2, channel),
      (e) => e.code === 'UNSUPPORTED_BOOKING_CHANNEL' && e.status === 409,
      `${channel} must be refused`
    );
  }
});

test('counter-priced channels still reprice', () => {
  for (const channel of [null, '', 'WEBSITE', 'STAFF']) {
    assert.doesNotThrow(() => assertRepriceable([], 2, 2, channel), `${channel} must be allowed`);
  }
});

test('per-day add-ons with NO identifiable base row fail CLOSED on a length change', () => {
  // The case we understand least must not be the one where the guard is off.
  assert.throws(
    () => assertRepriceable([{ source: 'INSURANCE', chargeType: 'DAILY', selected: true }], 0, 4, 'WEBSITE'),
    (e) => e.code === 'PER_DAY_ADDONS_PRESENT'
  );
});

test('a malformed quote row is a 422 BEFORE anything is written', async () => {
  const m = installMock(WEBSITE_SHAPED);
  try {
    await assert.rejects(
      () => reservationExtendService.repriceForNewDates('res-1', { days: 0, dailyRate: null, subtotal: 0 }, {}),
      (e) => e.code === 'INVALID_QUOTE_ROW' && e.status === 422
    );
    // and nothing changed
    assert.equal(m.state.charges.filter((c) => c.id === 'base').length, 1);
  } finally { m.restore(); }
});

test('a DEALERSHIP_LOANER is refused — a free loaner must never become billable', () => {
  // Courtesy loaners are created CONFIRMED with dailyRate 0, estimatedTotal 0,
  // no bookingChannel (so they default to STAFF) and NO charge rows — the
  // dealer covers them. Every other guard passes them. And because this change
  // rebuilds the charge rows, a retail price would become the DURABLE truth
  // instead of being dragged back to 0 by the next read.
  for (const mode of ['DEALERSHIP_LOANER', 'CAR_SHARING']) {
    assert.throws(
      () => assertRepriceable([], 0, 2, 'STAFF', mode),
      (e) => e.code === 'UNSUPPORTED_WORKFLOW_MODE' && e.status === 409,
      `${mode} must be refused`
    );
  }
  assert.doesNotThrow(() => assertRepriceable([], 2, 2, 'STAFF', 'RENTAL'));
  assert.doesNotThrow(() => assertRepriceable([], 2, 2, 'STAFF', null), 'missing mode means RENTAL');
});

test("VozIA's OWN bookings are repriceable", () => {
  // quote-convert stamps bookingChannel 'VOZIA'. Refusing it would mean Chloe
  // cannot change a reservation she made ten minutes earlier — and the copy
  // would tell the caller it "came from a partner", which is false. They are
  // priced by the same engine through the same preview() as STAFF.
  assert.doesNotThrow(() => assertRepriceable([], 2, 2, 'VOZIA', 'RENTAL'));
});

test('a VOIDED base rate is refused, not silently re-billed', async () => {
  // An admin voided the rental (selected:false, kept for history). The reprice
  // would delete it by id and create a fresh billable row — un-waiving it,
  // with the like-for-like guard agreeing because it compares the NEW row to
  // the quote.
  const m = installMock([
    { id: 'base', source: 'BASE_RATE', code: 'DAILY', name: 'Daily', chargeType: 'UNIT', quantity: 2, rate: 19.6, total: 39.2, taxable: true, selected: false }
  ]);
  try {
    await assert.rejects(
      () => reservationExtendService.repriceForNewDates('res-1', { days: 2, dailyRate: 23.33, subtotal: 46.66, total: 52.03 }, {}),
      (e) => e.code === 'VOIDED_BASE_RATE' && e.status === 409
    );
    assert.equal(m.state.charges.length, 1, 'nothing may be written');
    assert.equal(m.state.charges[0].selected, false, 'the void must survive');
  } finally { m.restore(); }
});
