/**
 * Level 3 real line items — PURE suite. No prisma, no network, no clock.
 *
 * The bug this suite exists to keep dead: sending Visa a Level 3 block whose
 * line items do not add up to the money that moved.
 *
 * RFM has been sending L3 on every Transact CNP transaction since June —
 * `LineItemCount: 1`, one synthetic "Vehicle rental" line, `TaxAmount: 0`.
 * Harmless because it says nothing. The moment it starts saying something,
 * every line has to be true, because Dejavoo's L2/L3 validator can HARD-FAIL a
 * transaction (l2l3Flag "E", ipos-transact-client.js:330-341) — a wrong payload
 * declines a real card at the counter to improve a reporting field.
 *
 * Pinned here, hardest first:
 *   • the §5.3 invariant, BOTH ways: it holds on a real agreement, and it
 *     REFUSES rather than sends when a cent goes missing;
 *   • deposits never reach a line item, never reach LineItemCount, and never
 *     reach the amount — the $339.20-instead-of-$89.20 incident in numbers;
 *   • the TAX row is never emitted as its own line (it would double-count
 *     against the header TaxAmount that already carries it);
 *   • every line carries all EIGHT mandatory CEDP fields, always;
 *   • the fallback: every refusal path returns ok:false with a reason, so the
 *     caller can send the old payload instead of a wrong new one;
 *   • normalizeRentalClassId — the 2201 that killed the May 2026 live test;
 *   • the validation-error mapper, including the flat→nested key names that
 *     do not match anything we send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLevel3LineItems,
  unitOfMeasureFor,
  taxRateFor,
  l3Description,
  normalizeRentalClassId,
  TAX_ALLOCATION,
  L3_REFUSAL,
  UOM_DAY,
  UOM_EACH,
} from './autorental-l3.builder.js';

import {
  extractValidationErrors,
  describeValidationErrors,
  isAutoRentalAccepted,
  L2L3_FIELD_MAP,
  AUTORENTAL_FIELD_MAP,
} from './autorental-validation.js';

import { isDepositCharge, isTaxCharge } from '../../lib/charge-predicates.js';

// ---------------------------------------------------------------------------
// Fixtures — a real IRC-shaped agreement, in real dollars.
//
// 4-day rental at $89.20/day. Row shapes are copied from the actual write
// sites, not invented:
//   BASE_RATE     rental-agreements.service.js:2863     chargeType 'DAILY'
//   INSURANCE     booking-engine.service.js:1943        chargeType 'UNIT', qty = days
//   MANDATORY_FEE booking-engine.service.js             chargeType 'UNIT', qty 1
//   TAX           booking-engine.service.js:1957        chargeType 'TAX'
//   DEPOSIT       booking-engine.service.js:1969        code 'DEPOSIT'
// ---------------------------------------------------------------------------

const TAX_RATE = 11.5;           // Puerto Rico IVU, Location.taxRate as a percent
const DAYS = 4;

const BASE      = { sortOrder: 0,  code: 'DAILY',   name: 'Daily',                        chargeType: 'DAILY', quantity: 4, rate: 89.20, total: 356.80, taxable: true,  selected: true, source: 'BASE_RATE' };
const INSURANCE = { sortOrder: 10, code: 'CDW',     name: 'Insurance: Full Protection',   chargeType: 'UNIT',  quantity: 4, rate: 24.99, total: 99.96,  taxable: true,  selected: true, source: 'INSURANCE' };
const GPS       = { sortOrder: 20, code: 'GPS',     name: 'Service: GPS Navigation',      chargeType: 'UNIT',  quantity: 1, rate: 35.00, total: 35.00,  taxable: true,  selected: true, source: 'SERVICE' };
const AIRPORT   = { sortOrder: 30, code: 'APT',     name: 'Fee: Airport Surcharge',       chargeType: 'UNIT',  quantity: 1, rate: 12.50, total: 12.50,  taxable: false, selected: true, source: 'MANDATORY_FEE' };
const TAX_ROW   = { sortOrder: 90, code: 'TAX',     name: 'Sales Tax (11.50%)',           chargeType: 'TAX',   quantity: 1, rate: 41.03, total: 41.03,  taxable: false, selected: true, source: 'TAX' };
const DEPOSIT   = { sortOrder: 95, code: 'DEPOSIT', name: 'Deposit (Due Now)',            chargeType: 'UNIT',  quantity: 1, rate: 250.00, total: 250.00, taxable: false, selected: true, source: 'DEPOSIT_DUE' };
const SEC_DEP   = { sortOrder: 96, code: 'SECURITY_DEPOSIT', name: 'Security Deposit',    chargeType: 'DEPOSIT', quantity: 1, rate: 500.00, total: 500.00, taxable: false, selected: true, source: 'SECURITY_DEPOSIT' };

// 356.80 + 99.96 + 35.00 + 12.50 = 504.26 subtotal; + 41.03 tax = 545.29 total.
const LINE_SUBTOTAL = 504.26;
const TAX_TOTAL = 41.03;
const AGREEMENT_TOTAL = 545.29;

const FULL_CHARGES = [BASE, INSURANCE, GPS, AIRPORT, TAX_ROW, DEPOSIT, SEC_DEP];

const build = (over = {}) => buildLevel3LineItems({
  amount: AGREEMENT_TOTAL,
  charges: FULL_CHARGES,
  taxAmount: TAX_TOTAL,
  taxRate: TAX_RATE,
  agreementNumber: 'RA-20260904103000-0042',
  orderDate: new Date('2026-09-04T10:30:00Z'),
  rentalDays: DAYS,
  ...over,
});

// ===========================================================================
test('§5.3 invariant — Σ ExtLineAmount + header TaxAmount equals the amount to the cent', () => {
  const r = build();
  assert.equal(r.ok, true, r.ok ? '' : `refused: ${r.reason}`);

  const sum = r.items.reduce((s, i) => s + i.ExtLineAmount, 0);
  assert.equal(Number(sum.toFixed(2)), LINE_SUBTOTAL);
  assert.equal(r.header.TaxAmount, TAX_TOTAL);
  assert.equal(Number((sum + r.header.TaxAmount).toFixed(2)), AGREEMENT_TOTAL);

  // And in cents, so no float slack hides in toFixed.
  const cents = r.items.reduce((s, i) => s + Math.round(i.ExtLineAmount * 100), 0)
    + Math.round(r.header.TaxAmount * 100);
  assert.equal(cents, Math.round(AGREEMENT_TOTAL * 100));
});

test('§5.3 invariant — REFUSES when a single cent goes missing, and never sends', () => {
  // One cent more than the lines can account for.
  const r = build({ amount: 545.30 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, L3_REFUSAL.SUM_MISMATCH);
  assert.equal(r.detail.deltaCents, 1);
  assert.equal(r.items, undefined, 'a refusal must not hand back items to send');
});

test('§5.3 invariant — REFUSES a cent in the other direction too', () => {
  const r = build({ amount: 545.28 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, L3_REFUSAL.SUM_MISMATCH);
  assert.equal(r.detail.deltaCents, -1);
});

test('§5.3 — an ad-hoc card-on-file amount (the live spinChargeCardOnFile case) refuses', () => {
  // An agent charging $75 of tolls against this agreement. The charge rows
  // describe $545.29. Nothing about $75 is itemizable — refuse, log, fall back.
  const r = build({ amount: 75.00 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, L3_REFUSAL.SUM_MISMATCH);
  assert.equal(r.detail.amount, 75.00);
  assert.equal(r.detail.lineTotal, LINE_SUBTOTAL);
});

// ===========================================================================
test('deposits are excluded entirely — not a line, not in LineItemCount, not in the money', () => {
  const r = build();
  assert.equal(r.ok, true);

  // Two deposit rows in, zero out.
  assert.equal(r.excludedDeposits, 2);
  assert.equal(r.lineItemCount, 4);
  assert.equal(r.header.LineItemCount, 4);
  assert.equal(r.items.length, 4);

  for (const item of r.items) {
    assert.ok(!/deposit/i.test(item.Description), `deposit leaked into a line: ${item.Description}`);
  }
  // The $750 of deposits never touched the total.
  assert.equal(r.lineTotal, LINE_SUBTOTAL);
});

test('deposits — the 2026-05-23 double-charge in numbers ($89.20 became $339.20)', () => {
  // doc/round-26-followups-2026-05-23.md §10: a $250 security deposit was
  // summed into the SALE while also being held as a separate AUTH.
  const rental  = { sortOrder: 0, name: 'Daily', chargeType: 'DAILY', quantity: 1, rate: 89.20, total: 89.20, selected: true, source: 'BASE_RATE' };
  const deposit = { sortOrder: 1, name: 'Security Deposit', chargeType: 'UNIT', quantity: 1, rate: 250, total: 250, selected: true, source: 'SECURITY_DEPOSIT' };

  const r = buildLevel3LineItems({ amount: 89.20, charges: [rental, deposit], taxAmount: 0, taxRate: 0 });
  assert.equal(r.ok, true, 'the CORRECT amount must build');
  assert.equal(r.lineTotal, 89.20);
  assert.equal(r.lineItemCount, 1);

  // And the wrong amount is refused rather than itemized into legitimacy.
  const wrong = buildLevel3LineItems({ amount: 339.20, charges: [rental, deposit], taxAmount: 0, taxRate: 0 });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, L3_REFUSAL.SUM_MISMATCH);
});

test('deposits — every isDepositCharge() shape is caught, including legacy null-source rows', () => {
  const shapes = [
    { chargeType: 'DEPOSIT', total: 100 },
    { source: 'DEPOSIT_DUE', total: 100 },
    { source: 'SECURITY_DEPOSIT', total: 100 },
    { name: 'Security Deposit', total: 100 },          // legacy: code+source null
    { name: 'Deposit (Due Now)', total: 100 },
    { name: 'security deposit', total: 100 },          // case-insensitive
  ];
  for (const d of shapes) {
    assert.equal(isDepositCharge(d), true, `predicate missed ${JSON.stringify(d)}`);
    const r = buildLevel3LineItems({
      amount: 50, taxAmount: 0, taxRate: 0,
      charges: [{ name: 'Daily', chargeType: 'DAILY', quantity: 1, rate: 50, total: 50, selected: true }, { selected: true, ...d }],
    });
    assert.equal(r.ok, true, `deposit shape leaked: ${JSON.stringify(d)}`);
    assert.equal(r.lineItemCount, 1);
    assert.equal(r.excludedDeposits, 1);
  }
});

// ===========================================================================
test('the TAX row is NEVER a line item — its money lives in the header only', () => {
  const r = build();
  assert.equal(r.ok, true);

  for (const item of r.items) {
    assert.ok(!/sales tax/i.test(item.Description), 'the TAX row was emitted as a line item');
  }
  assert.equal(r.header.TaxAmount, TAX_TOTAL);

  // Emitting it would double-count: 504.26 + 41.03 + 41.03 = 586.32 ≠ 545.29.
  const wouldBe = LINE_SUBTOTAL + TAX_TOTAL + TAX_TOTAL;
  assert.notEqual(Number(wouldBe.toFixed(2)), AGREEMENT_TOTAL);
});

test('header TaxAmount defaults to Σ TAX rows when the caller passes none', () => {
  const r = build({ taxAmount: null });
  assert.equal(r.ok, true);
  assert.equal(r.header.TaxAmount, TAX_TOTAL);
});

test('a caller-supplied TaxAmount wins over the TAX rows (RentalAgreement.taxes is authoritative)', () => {
  // TAX_RECALC can leave the rows and the stored total disagreeing. Plan §4.1
  // makes RentalAgreement.taxes authoritative — and then the invariant decides.
  const r = build({ taxAmount: 41.03, charges: [BASE, INSURANCE, GPS, AIRPORT, { ...TAX_ROW, total: 99.99 }] });
  assert.equal(r.ok, true);
  assert.equal(r.header.TaxAmount, 41.03);
});

// ===========================================================================
test('every line carries all EIGHT mandatory CEDP fields', () => {
  const MANDATORY = [
    'Description', 'Quantity', 'UnitOfMeasure', 'UnitCost',
    'TaxRate', 'DiscountAmount', 'DiscountIndicator', 'ExtLineAmount',
  ];
  const r = build();
  assert.equal(r.ok, true);
  for (const item of r.items) {
    for (const f of MANDATORY) {
      assert.ok(Object.hasOwn(item, f), `line "${item.Description}" is missing ${f}`);
      assert.notEqual(item[f], undefined, `line "${item.Description}" has undefined ${f}`);
    }
    assert.equal(typeof item.Description, 'string');
    assert.equal(typeof item.Quantity, 'number');
    assert.equal(typeof item.UnitCost, 'number');
    assert.equal(typeof item.ExtLineAmount, 'number');
    assert.equal(typeof item.DiscountIndicator, 'boolean');
  }
});

test('header carries the summary fields, and omits the ones RFM cannot honestly fill', () => {
  const r = build();
  assert.equal(r.header.LineItemCount, 4);
  assert.equal(r.header.PurchaseIdFormatCode, '3');   // Auto Rental Agreement Number
  assert.equal(r.header.PurchaseIdentifier, 'RA-20260904103000-0042');
  assert.equal(r.header.OrderDate, '2026-09-04');
  assert.equal(r.header.LocalTaxFlag, 1);

  // Plan §4.1/§4.5: no destination is modelled; customerZip is the renter's
  // HOME zip. A confidently wrong value is worse than a missing one.
  assert.ok(!Object.hasOwn(r.header, 'DestZipCode'));
  // No column exists — only sent when a tenant configures it (§6.3).
  assert.ok(!Object.hasOwn(r.header, 'SummaryCommodityCode'));
});

test('SummaryCommodityCode is sent only when the tenant configured one', () => {
  assert.ok(!Object.hasOwn(build({ summaryCommodityCode: '   ' }).header, 'SummaryCommodityCode'));
  assert.equal(build({ summaryCommodityCode: '3355' }).header.SummaryCommodityCode, '3355');
});

test('LocalTaxFlag is 0 with no tax, and the AutoRental enum form is carried alongside', () => {
  const r = buildLevel3LineItems({
    amount: 50, taxAmount: 0, taxRate: 0,
    charges: [{ name: 'Daily', chargeType: 'DAILY', quantity: 1, rate: 50, total: 50, selected: true }],
  });
  assert.equal(r.header.LocalTaxFlag, 0);
  assert.equal(r.localTaxFlagEnum, 'NotProvided');
  assert.equal(build().localTaxFlagEnum, 'LocalOrSales');
});

test('PurchaseIdentifier is capped at 25 — a 22-char agreementNumber survives intact', () => {
  assert.equal(build().header.PurchaseIdentifier.length, 22);
  const long = build({ agreementNumber: 'X'.repeat(60) });
  assert.equal(long.header.PurchaseIdentifier.length, 25);
});

// ===========================================================================
test('UnitOfMeasure — DAY for the daily rental line in BOTH shapes the codebase writes', () => {
  // rental-agreements.service.js:2863 — chargeType 'DAILY'
  assert.equal(unitOfMeasureFor({ chargeType: 'DAILY', quantity: 4 }), UOM_DAY);
  // reservation-pricing.service.js:1078 — chargeType 'UNIT', code 'DAILY'
  assert.equal(unitOfMeasureFor({ chargeType: 'UNIT', code: 'DAILY', quantity: 4, source: 'BASE_RATE' }), UOM_DAY);
  // reservation-extend.service.js:267
  assert.equal(unitOfMeasureFor({ chargeType: 'DAILY', code: 'EXTENSION_RATE' }), UOM_DAY);
  // car-sharing.service.js:269
  assert.equal(unitOfMeasureFor({ chargeType: 'DAILY', code: 'TRIP_DAILY' }), UOM_DAY);
});

test('UnitOfMeasure — PER_DAY insurance is DAY only when rentalDays makes it evidence', () => {
  // chargeType 'UNIT', quantity 4 — indistinguishable from a 4-unit fee on its own.
  assert.equal(unitOfMeasureFor(INSURANCE), UOM_EACH, 'must not GUESS a per-day unit');
  assert.equal(unitOfMeasureFor(INSURANCE, { rentalDays: 4 }), UOM_DAY);
  // A quantity that does not match the rental window is not a per-day line.
  assert.equal(unitOfMeasureFor(INSURANCE, { rentalDays: 7 }), UOM_EACH);
});

test('UnitOfMeasure — one-off fees and services are EA', () => {
  assert.equal(unitOfMeasureFor(GPS, { rentalDays: 4 }), UOM_EACH);
  assert.equal(unitOfMeasureFor(AIRPORT, { rentalDays: 4 }), UOM_EACH);
  assert.equal(unitOfMeasureFor({ chargeType: 'PERCENT', quantity: 1 }, { rentalDays: 4 }), UOM_EACH);
  assert.equal(unitOfMeasureFor({}, { rentalDays: 4 }), UOM_EACH);
  // rentalDays 1 must never turn every quantity-1 fee into a DAY.
  assert.equal(unitOfMeasureFor(GPS, { rentalDays: 1 }), UOM_EACH);
});

test('UnitOfMeasure — the built payload matches the derivation', () => {
  const byName = Object.fromEntries(build().items.map((i) => [i.Description, i.UnitOfMeasure]));
  assert.equal(byName['Daily'], UOM_DAY);
  assert.equal(byName['Insurance: Full Protection'], UOM_DAY);      // rentalDays 4 supplied
  assert.equal(byName['Service: GPS Navigation'], UOM_EACH);
  assert.equal(byName['Fee: Airport Surcharge'], UOM_EACH);
});

// ===========================================================================
test('tax allocation — LOCATION_RATE stamps the rate on non-deposit, non-TAX, non-FEE_ENGINE lines', () => {
  const r = build();
  const byName = Object.fromEntries(r.items.map((i) => [i.Description, i.TaxRate]));
  assert.equal(byName['Daily'], TAX_RATE);
  assert.equal(byName['Insurance: Full Protection'], TAX_RATE);
  assert.equal(byName['Service: GPS Navigation'], TAX_RATE);
  // AIRPORT is taxable:false but IS stamped — LOCATION_RATE ignores the flag
  // on purpose (see the strategy comment: `taxable` is inconsistent).
  assert.equal(byName['Fee: Airport Surcharge'], TAX_RATE);
});

test('tax allocation — fee-engine check-in lines get rate 0 (priced post-tax)', () => {
  const feeRow = { sortOrder: 40, name: 'Late Return', chargeType: 'UNIT', quantity: 2, rate: 25, total: 50, selected: true, source: 'FEE_ENGINE_CHECKIN' };
  assert.equal(taxRateFor(feeRow, { taxRate: TAX_RATE }), 0);
  assert.equal(taxRateFor(BASE, { taxRate: TAX_RATE }), TAX_RATE);
});

test('tax allocation — line TaxAmount stays 0; the money is in the header (NOTES §5 gap 1)', () => {
  for (const item of build().items) assert.equal(item.TaxAmount, 0);
});

test('tax allocation — TAXABLE_FLAG is available and behaves differently, which is why it is not the default', () => {
  const r = build({ taxAllocation: TAX_ALLOCATION.TAXABLE_FLAG });
  const byName = Object.fromEntries(r.items.map((i) => [i.Description, i.TaxRate]));
  assert.equal(byName['Daily'], TAX_RATE);                  // taxable: true
  assert.equal(byName['Fee: Airport Surcharge'], 0);        // taxable: false
  // The divergence itself: the same conceptual base-rate line is written
  // taxable:true by rental-agreements.service.js:2863 and taxable:false by
  // reservation-pricing.service.js:1078. Two agreements owing identical money
  // would produce different L3 blocks — hence LOCATION_RATE is the default.
  const pricingShaped = { name: 'Daily', chargeType: 'UNIT', code: 'DAILY', quantity: 4, rate: 89.20, total: 356.80, taxable: false, selected: true, source: 'BASE_RATE' };
  assert.equal(taxRateFor(pricingShaped, { taxRate: TAX_RATE, taxAllocation: TAX_ALLOCATION.TAXABLE_FLAG }), 0);
  assert.equal(taxRateFor(pricingShaped, { taxRate: TAX_RATE, taxAllocation: TAX_ALLOCATION.LOCATION_RATE }), TAX_RATE);
});

test('tax allocation — a zero location rate stamps zero everywhere, and never NaN', () => {
  const r = build({ taxRate: 0 });
  assert.equal(r.ok, true);
  for (const item of r.items) assert.equal(item.TaxRate, 0);
});

// ===========================================================================
test('discounts — a negative line sets DiscountIndicator true and DiscountAmount to its magnitude', () => {
  // rental-agreements.service.js:2942 — name 'Discount', quantity 1, negative rate+total.
  const discount = { sortOrder: 50, name: 'Discount', chargeType: 'UNIT', quantity: 1, rate: -50, total: -50, taxable: false, selected: true };
  const r = buildLevel3LineItems({
    amount: AGREEMENT_TOTAL - 50,
    charges: [...FULL_CHARGES, discount],
    taxAmount: TAX_TOTAL, taxRate: TAX_RATE, rentalDays: DAYS,
  });
  assert.equal(r.ok, true, r.ok ? '' : `refused: ${r.reason}`);

  const line = r.items.find((i) => i.Description === 'Discount');
  assert.ok(line, 'the discount must be its own line, not netted away');
  assert.equal(line.ExtLineAmount, -50);
  assert.equal(line.DiscountIndicator, true);
  assert.equal(line.DiscountAmount, 50);
  assert.equal(r.header.TotalDiscountAmount, 50);

  // The credit is inside the invariant, not an exception to it.
  const sum = r.items.reduce((s, i) => s + i.ExtLineAmount, 0);
  assert.equal(Number((sum + r.header.TaxAmount).toFixed(2)), Number((AGREEMENT_TOTAL - 50).toFixed(2)));
});

test('discounts — an ADMIN_CORRECTION credit is caught by sign, not by name', () => {
  // NOTES §5 gap 6: there is no source:'DISCOUNT' constant. Sign is the key.
  const credit = { sortOrder: 60, name: 'Goodwill adjustment', chargeType: 'UNIT', quantity: 1, rate: -20, total: -20, selected: true, source: 'ADMIN_CORRECTION' };
  const r = buildLevel3LineItems({
    amount: 30, taxAmount: 0, taxRate: 0,
    charges: [{ name: 'Daily', chargeType: 'DAILY', quantity: 1, rate: 50, total: 50, selected: true }, credit],
  });
  assert.equal(r.ok, true);
  const line = r.items.find((i) => i.ExtLineAmount < 0);
  assert.equal(line.DiscountIndicator, true);
  assert.equal(line.DiscountAmount, 20);
});

test('non-discount lines report DiscountIndicator false and DiscountAmount 0', () => {
  for (const item of build().items) {
    assert.equal(item.DiscountIndicator, false);
    assert.equal(item.DiscountAmount, 0);
  }
  assert.equal(build().header.TotalDiscountAmount, 0);
});

// ===========================================================================
test('Quantity/UnitCost come from the row when they reconcile', () => {
  const daily = build().items.find((i) => i.Description === 'Daily');
  assert.equal(daily.Quantity, 4);
  assert.equal(daily.UnitCost, 89.20);
  assert.equal(daily.ExtLineAmount, 356.80);
  assert.equal(Number((daily.Quantity * daily.UnitCost).toFixed(2)), daily.ExtLineAmount);
});

test('Quantity/UnitCost collapse to 1 x total when the row does NOT multiply out', () => {
  // A stale rate after a reprice: 3 x 20 = 60, but total says 55. ExtLineAmount
  // is the money and must survive; the quantity/rate pair is what gives way.
  const stale = { name: 'Repriced add-on', chargeType: 'UNIT', quantity: 3, rate: 20, total: 55, selected: true };
  const r = buildLevel3LineItems({ amount: 55, charges: [stale], taxAmount: 0, taxRate: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].Quantity, 1);
  assert.equal(r.items[0].UnitCost, 55);
  assert.equal(r.items[0].ExtLineAmount, 55);
});

test('Quantity/UnitCost — a row with no quantity or rate still produces a valid line', () => {
  const bare = { name: 'Toll Charge - Teodoro Moscoso', total: 4.75, selected: true, source: 'TOLL_MODULE' };
  const r = buildLevel3LineItems({ amount: 4.75, charges: [bare], taxAmount: 0, taxRate: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].Quantity, 1);
  assert.equal(r.items[0].UnitCost, 4.75);
  assert.equal(r.items[0].ExtLineAmount, 4.75);
});

test('Prisma Decimal-like objects are read as numbers, not NaN', () => {
  const dec = (v) => ({ toString: () => String(v) });   // Decimal stringifies cleanly
  const r = buildLevel3LineItems({
    amount: 356.80, taxAmount: 0, taxRate: 0,
    charges: [{ name: 'Daily', chargeType: 'DAILY', quantity: dec(4), rate: dec('89.20'), total: dec('356.80'), selected: true }],
  });
  assert.equal(r.ok, true, r.ok ? '' : `refused: ${r.reason}`);
  assert.equal(r.items[0].Quantity, 4);
  assert.equal(r.items[0].UnitCost, 89.20);
  assert.equal(r.items[0].ExtLineAmount, 356.80);
});

// ===========================================================================
test('unselected rows are off the bill and off the itemization', () => {
  const r = build({ charges: [...FULL_CHARGES, { sortOrder: 70, name: 'Declined upsell', chargeType: 'UNIT', quantity: 1, rate: 99, total: 99, selected: false }] });
  assert.equal(r.ok, true, 'an unselected row must not break the invariant');
  assert.equal(r.lineItemCount, 4);
});

test('lines are ordered by sortOrder — the L3 block reads like the agreement', () => {
  const shuffled = [AIRPORT, TAX_ROW, BASE, DEPOSIT, GPS, INSURANCE];
  const r = build({ charges: shuffled });
  assert.deepEqual(r.items.map((i) => i.Description), [
    'Daily', 'Insurance: Full Protection', 'Service: GPS Navigation', 'Fee: Airport Surcharge',
  ]);
});

// ===========================================================================
test('fallback — a one-line agreement is a perfectly valid L3 block', () => {
  const r = buildLevel3LineItems({
    amount: 100, taxAmount: 0, taxRate: 0,
    charges: [{ name: 'Daily', chargeType: 'DAILY', quantity: 2, rate: 50, total: 100, selected: true }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.lineItemCount, 1);
  assert.equal(r.header.LineItemCount, 1);
});

test('fallback — NO_CHARGES when the caller passes nothing (the deposit-hold path)', () => {
  for (const charges of [[], null, undefined]) {
    const r = buildLevel3LineItems({ amount: 250, charges });
    assert.equal(r.ok, false);
    assert.equal(r.reason, L3_REFUSAL.NO_CHARGES);
  }
});

test('fallback — NO_LINE_ITEMS when every row is a deposit or the tax row', () => {
  const r = buildLevel3LineItems({ amount: 250, charges: [DEPOSIT, SEC_DEP, TAX_ROW], taxAmount: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, L3_REFUSAL.NO_LINE_ITEMS);
  assert.equal(r.detail.deposits, 2);
  assert.equal(r.detail.taxRows, 1);
});

test('fallback — AMOUNT_NOT_POSITIVE for zero, negative and non-numeric amounts', () => {
  for (const amount of [0, -5, null, undefined, 'abc', NaN]) {
    const r = buildLevel3LineItems({ amount, charges: FULL_CHARGES });
    assert.equal(r.ok, false, `amount ${String(amount)} should refuse`);
    assert.equal(r.reason, L3_REFUSAL.AMOUNT_NOT_POSITIVE);
  }
});

test('fallback — every refusal names a reason and carries no items', () => {
  const refusals = [
    buildLevel3LineItems({ amount: 0, charges: FULL_CHARGES }),
    buildLevel3LineItems({ amount: 100, charges: [] }),
    buildLevel3LineItems({ amount: 100, charges: [DEPOSIT] }),
    build({ amount: 1 }),
  ];
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.ok(Object.values(L3_REFUSAL).includes(r.reason), `unknown reason ${r.reason}`);
    assert.equal(r.items, undefined);
    assert.equal(typeof r.detail, 'object');
  }
});

// ===========================================================================
test('Description — transliterated to ASCII and capped at 35 (D-8 / M-5)', () => {
  assert.equal(l3Description('Seguro: Protección Total'), 'Seguro: Proteccion Total');
  // The em-dash is dropped first, THEN the doubled space collapses — so the
  // 35 chars are 35 chars of content, not padding around a hole.
  assert.equal(l3Description('Recargo por conductor joven — menor de 25'), 'Recargo por conductor joven menor d');
  assert.equal(l3Description('x'.repeat(80)).length, 35);
  assert.equal(l3Description('  Fee:   Airport   Surcharge  '), 'Fee: Airport Surcharge');
  assert.equal(l3Description(null), '');
  // A row with no usable name still gets a Description — the field is mandatory.
  const r = buildLevel3LineItems({ amount: 10, taxAmount: 0, taxRate: 0, charges: [{ total: 10, selected: true }] });
  assert.equal(r.items[0].Description, 'Rental charge');
});

// ===========================================================================
// normalizeRentalClassId — the 2201. Restored, unused until the AutoRental
// phase. doc/round-26-followups-2026-05-23.md §11.
// ===========================================================================
test('normalizeRentalClassId — ACRISS LETTER codes become 9999 (this is the 2201)', () => {
  // "Invalid request data : Rental Class Id must be 4 Digit value or Rental
  // Class Id is not between 0001-0032 and 9999" — every live AutoRental/Sale
  // on 2026-05-23 was rejected before the terminal showed anything.
  for (const acriss of ['SFAR', 'ECAR', 'CDMR', 'IFAR', 'MBMN']) {
    assert.equal(normalizeRentalClassId(acriss), '9999');
  }
});

test('normalizeRentalClassId — valid 4-digit codes in 0001-0032 pass through unchanged', () => {
  for (const code of ['0001', '0002', '0016', '0031', '0032']) {
    assert.equal(normalizeRentalClassId(code), code, 'must preserve the string, leading zeros included');
  }
});

test('normalizeRentalClassId — the 9999 catch-all passes through', () => {
  assert.equal(normalizeRentalClassId('9999'), '9999');
});

test('normalizeRentalClassId — out-of-range 4-digit numbers fall back to 9999', () => {
  for (const code of ['0000', '0033', '0100', '1234', '9998']) {
    assert.equal(normalizeRentalClassId(code), '9999');
  }
});

test('normalizeRentalClassId — wrong-length numerics fall back to 9999', () => {
  for (const code of ['1', '12', '123', '00001', '000032']) {
    assert.equal(normalizeRentalClassId(code), '9999');
  }
});

test('normalizeRentalClassId — empty, null, undefined and whitespace fall back to 9999', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(normalizeRentalClassId(v), '9999');
});

test('normalizeRentalClassId — surrounding whitespace is trimmed, not rejected', () => {
  assert.equal(normalizeRentalClassId('  0012  '), '0012');
});

test('normalizeRentalClassId — non-strings are coerced, never thrown on', () => {
  assert.equal(normalizeRentalClassId(12), '9999');
  assert.equal(normalizeRentalClassId(9999), '9999');
  assert.equal(normalizeRentalClassId({}), '9999');
  assert.equal(normalizeRentalClassId([]), '9999');
});

// ===========================================================================
// Validation errors inside a 200 OK — plan §5.4
// ===========================================================================
const CLEAN_200 = {
  L2L3ValidationError: {
    Description: '', PoNumber: '', PurchaseIdentifier: '', SummaryCommodityCode: '',
    LineItemCount: '', TaxAmount: '', Quantity: '', UnitOfMeasure: '', UnitCost: '',
    TaxRate: '', DiscountAmount: '', DebitCreditIndicator: '', ExtLineAmount: '',
    QuantityExpIndicator: '', UnitPriceDecimal: '',
  },
  AutoRentalValidationError: { PickupAddress: '', PickupDate: '', RentalDuration: '' },
  ExtData: { ARLFlag: 'Y' },
};

test('validation — an all-empty error object is a PASS, not 15 failures', () => {
  const r = extractValidationErrors(CLEAN_200);
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(describeValidationErrors(CLEAN_200), '');
  assert.equal(isAutoRentalAccepted(CLEAN_200), true);
});

test('validation — a populated key is a FAILURE even though the response is a 200 OK', () => {
  const approvedButBroken = {
    ...CLEAN_200,
    L2L3ValidationError: { ...CLEAN_200.L2L3ValidationError, UnitOfMeasure: 'Is invalid', TaxAmount: 'Is missing' },
    ExtData: { ARLFlag: '' },
  };
  const r = extractValidationErrors(approvedButBroken);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.equal(isAutoRentalAccepted(approvedButBroken), false, 'absent ARLFlag is not success');
});

test('validation — the log line names the RFM field, not just the gateway key', () => {
  const line = describeValidationErrors({
    L2L3ValidationError: { UnitOfMeasure: 'Is invalid' },
    AutoRentalValidationError: { RentalClassId: 'Is invalid' },
    ExtData: { ARLFlag: '' },
  });
  assert.match(line, /UnitOfMeasure/);
  assert.match(line, /chargeType/);                 // the RFM field behind it
  assert.match(line, /RentalClassId/);
  assert.match(line, /normalizeRentalClassId/);     // and where the fix lives
  assert.match(line, /Is invalid/);
  assert.match(line, /2 field\(s\)/);
  assert.match(line, /ARLFlag=/);
});

test('validation — the flat legacy keys map to the NESTED REST paths we actually send', () => {
  // Plan §5.4: these do not match, and that is the whole reason for the table.
  assert.equal(AUTORENTAL_FIELD_MAP.PickupAddress.path, 'AutoRental.AutoRentalPickup.Address');
  assert.equal(AUTORENTAL_FIELD_MAP.PickupDate.path, 'AutoRental.AutoRentalPickup.DateTime');
  assert.equal(
    AUTORENTAL_FIELD_MAP.RentalDistanceUnitofMeasure.path,
    'AutoRental.AutoRentalDistance.AutoRentalDistanceUnitofMeasure',
  );
});

test('validation — RentalTime/ReturnTime are named as having NO REST field', () => {
  // The REST request folds time into DateTime. An agent sent the raw key would
  // hunt for a field that does not exist in anything we sent.
  assert.match(AUTORENTAL_FIELD_MAP.RentalTime.path, /no REST field/);
  assert.match(AUTORENTAL_FIELD_MAP.ReturnTime.path, /no REST field/);
});

test('validation — every key from the documented 200 sample is in the table', () => {
  const sampleL2L3 = Object.keys(CLEAN_200.L2L3ValidationError);
  for (const k of sampleL2L3) {
    assert.ok(L2L3_FIELD_MAP[k], `L2L3 key "${k}" from the documented sample is unmapped`);
  }
  const sampleAutoRental = [
    'AdjustmentAmount', 'AdjustmentAuditIndicatorCode', 'AgreementReferenceNumber',
    'PickupAddress', 'PickupCity', 'PickupCountry', 'PickupCountryCode', 'PickupDate',
    'PickupLocation', 'PickupRegionCode', 'PickupState', 'RentalDistance',
    'RentalDistanceUnitofMeasure', 'RentalDuration', 'RentalPeriod', 'RentalRate',
    'RentalTime', 'ReturnAddress', 'ReturnDate', 'ReturnLocationId', 'ReturnRegionCode',
    'ReturnStateCountry', 'ReturnTime', 'ServiceMobile', 'VehicleMake', 'VehicleModel',
  ];
  for (const k of sampleAutoRental) {
    assert.ok(AUTORENTAL_FIELD_MAP[k], `AutoRental key "${k}" from the documented sample is unmapped`);
  }
});

test('validation — an UNKNOWN key is surfaced, never dropped', () => {
  const r = extractValidationErrors({ L2L3ValidationError: { SomeNewField: 'Is missing' } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unmapped, ['SomeNewField']);
  assert.match(describeValidationErrors({ L2L3ValidationError: { SomeNewField: 'Is missing' } }), /SomeNewField/);
});

test('validation — a response with no validation objects at all is not a failure', () => {
  assert.equal(extractValidationErrors({}).ok, true);
  assert.equal(extractValidationErrors(null).ok, true);
  assert.equal(describeValidationErrors({ iposhpresponse: { responseCode: 200 } }), '');
});

test('validation — the log line NEVER carries payload/PII, only field names and verdicts', () => {
  const line = describeValidationErrors({
    L2L3ValidationError: { Description: 'Is invalid' },
    AutoRentalValidationError: { RenterName: 'Is invalid', ServiceMobile: 'Is invalid' },
  });
  // The mapper is fed only keys and verdicts, so nothing else can appear.
  assert.ok(!/\d{3}-?\d{3}-?\d{4}/.test(line), 'a phone number reached the log line');
  assert.ok(!/@/.test(line), 'an email reached the log line');
  assert.match(line, /RenterName/);
  assert.match(line, /customerFirstName/);
});

test('validation — lowercase response envelopes are read too (the live iposhpresponse shape)', () => {
  const r = extractValidationErrors({
    l2l3ValidationError: { UnitCost: 'Is invalid' },
    extData: { ARLFlag: 'Y' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.arlFlag, 'Y');
});

// ===========================================================================
test('the shared predicate is the SAME function the reservation services export', async () => {
  // NOTES §5 gap 7: reuse, do not re-implement. If these ever stop being the
  // same object, a fourth copy has appeared and the definitions will drift.
  const extend = await import('../reservations/reservation-extend.service.js');
  assert.equal(extend.isDepositCharge, isDepositCharge);
  assert.equal(extend.isTaxCharge, isTaxCharge);
});
