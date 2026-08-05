/**
 * "Edit pricing → Save Override" must not delete fees an upstream system owns.
 *
 * Hector, 2026-08-05: MEX quotes a pay-at-destination booking with its own
 * Customer Facility Charge / Vehicle License Fee / Surcharge, and MEX WILL bill
 * them whatever RFM decides afterwards. replacePricing rebuilds the charge list
 * from the UI's synthesized payload, which knows nothing about those rows — so
 * without this rule an unrelated pricing edit silently drops a fee the customer
 * already owes. Same failure shape as the EXTENSION_RATE bug, generalised to
 * ownership.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Pure test — no DB. The prisma singleton is imported transitively and only
// needs a syntactically valid URL to construct.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@127.0.0.1:5432/none';

// Dynamic: static imports hoist above the env assignment above.
const {
  isExternallyOwnedCharge,
  isPreservedOnPricingRebuild,
  EXTERNALLY_OWNED_CHARGE_SOURCES,
} = await import('./reservation-pricing.service.js');
const { buildImportedFeeRows, MEX_CHARGE_SOURCE } = await import('../integrations/mex/mex-reservation-detail.js');

const DETAIL = {
  confirmation: 'WMX000FAD4',
  optionalServices: [
    { amount: 5.93, description: 'CUSTOMER FACILITY CHARGE' },
    { amount: 2.5, description: 'VEHICLE LICENSE FEE SJU' },
    { amount: 2.2, description: 'SURCHARGE' },
  ],
};

describe('imported fees survive a pricing rebuild', () => {
  it('a MEX-owned row is preserved; an engine-authored one is not', () => {
    assert.equal(isPreservedOnPricingRebuild({ source: MEX_CHARGE_SOURCE, code: 'IMPORTED_FEE' }), true);
    assert.equal(isPreservedOnPricingRebuild({ source: 'mex_import' }), true, 'case must not decide money');
    assert.equal(isPreservedOnPricingRebuild({ source: 'ADDITIONAL_SERVICE' }), false);
    assert.equal(isPreservedOnPricingRebuild({ source: null, code: 'BASE_RATE' }), false);
    assert.equal(isPreservedOnPricingRebuild({}), false);
  });

  it('EXTENSION_RATE keeps its own protection', () => {
    // The older rule must not be lost while generalising it.
    assert.equal(isPreservedOnPricingRebuild({ code: 'EXTENSION_RATE' }), true);
    assert.equal(isPreservedOnPricingRebuild({ code: 'extension_rate' }), true);
  });

  it('only sources we deliberately listed are externally owned', () => {
    assert.equal(isExternallyOwnedCharge({ source: 'MEX_IMPORT' }), true);
    assert.equal(isExternallyOwnedCharge({ source: 'TOLL_MODULE' }), false,
      'tolls have their own reconciliation and must keep it');
    assert.deepEqual([...EXTERNALLY_OWNED_CHARGE_SOURCES], ['MEX_IMPORT']);
  });

  it('the rebuild filter drops preserved rows from BOTH the delete set and the payload', () => {
    // Mirrors replacePricing: existing rows are split, and payload rows that
    // claim a preserved identity are ignored so the UI cannot duplicate them.
    const existing = [
      { id: 'a', code: 'BASE_RATE', source: null },
      { id: 'b', code: 'IMPORTED_FEE', source: 'MEX_IMPORT' },
      { id: 'c', code: 'EXTENSION_RATE', source: null },
    ];
    const deletable = existing.filter((r) => !isPreservedOnPricingRebuild(r)).map((r) => r.id);
    assert.deepEqual(deletable, ['a'], 'only engine-owned rows may be rebuilt');

    const payload = [
      { code: 'BASE_RATE', total: 100 },
      { code: 'IMPORTED_FEE', source: 'MEX_IMPORT', total: 5.93 },
    ];
    const rebuilt = payload.filter((r) => !isPreservedOnPricingRebuild(r));
    assert.equal(rebuilt.length, 1, 'a preserved row must never be re-created from the payload');
  });
});

describe('buildImportedFeeRows', () => {
  it('turns OPTIONAL SERVICES into charge rows with a stable identity', () => {
    const rows = buildImportedFeeRows(DETAIL);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, 'CUSTOMER FACILITY CHARGE');
    assert.equal(rows[0].total, 5.93);
    assert.equal(rows[0].source, 'MEX_IMPORT');
    // Stable per (confirmation, service) so a re-sync updates instead of
    // stacking a second copy of the same fee.
    assert.equal(rows[0].sourceRefId, 'WMX000FAD4:CUSTOMER FACILITY CHARGE');
    assert.equal(rows.every((r) => r.taxable === true), true,
      'MEX taxes rate+fees at 11.5% — a non-taxable fee would under-collect once the engine computes the tax');
  });

  it('ignores junk rather than importing a zero-value fee', () => {
    const rows = buildImportedFeeRows({
      confirmation: 'X1',
      optionalServices: [
        { amount: 4.5, description: 'REAL FEE' },
        { amount: null, description: 'NO AMOUNT' },
        { amount: 1.0, description: '' },
        null,
      ],
    });
    assert.deepEqual(rows.map((r) => r.name), ['REAL FEE']);
  });

  it('returns nothing when there is no detail at all', () => {
    assert.deepEqual(buildImportedFeeRows(null), []);
    assert.deepEqual(buildImportedFeeRows({}), []);
    assert.deepEqual(buildImportedFeeRows({ optionalServices: [] }), []);
  });
});

describe('the imported quote reconciles to what MEX told the customer', () => {
  // WMX000FAD4, verbatim from the portal: 1180 + 147.92 + 106.30 = 1434.22
  const FAD4 = {
    confirmation: 'WMX000FAD4',
    confirmedRate: '826.00/Week , 118.00/XDay  UNL',
    charges: { rateTotal: 1180, taxTotal: 147.92, extraTotal: 106.30, estimatedTotal: 1434.22 },
    optionalServices: [
      { amount: 5.93, description: 'CUSTOMER FACILITY CHARGE' },
      { amount: 2.5, description: 'VEHICLE LICENSE FEE SJU' },
      { amount: 2.2, description: 'SURCHARGE' },
    ],
  };

  it('OUR tax over rental+fees reproduces the portal Estimated Total exactly', async () => {
    // Hector, 2026-08-05: "dont pass taxes just let the system calculate the
    // taxes". Safe because MEX's Est Tax Total is 11.5% of (rate + fees) on all
    // nine live bookings, and 11.5% is SJU's own taxRate — so the engine lands
    // on MEX's number without importing it.
    const { buildImportedQuoteRows, quoteReconciliation } =
      await import('../integrations/mex/mex-reservation-detail.js');
    const rows = buildImportedQuoteRows(FAD4, { days: 10, taxRate: 11.5 });

    const tax = rows.find((r) => r.chargeType === 'TAX');
    assert.equal(tax.total, 147.92, 'computed tax must equal the tax MEX quoted');
    assert.equal(tax.source, 'TAX', 'engine identity, so a recompute replaces it');
    assert.equal(rows.filter((r) => r.code === 'IMPORTED_TAX').length, 0, "MEX's tax is not imported");

    const rec = quoteReconciliation(rows, FAD4);
    assert.equal(rec.ok, true, `rows ${rec.actual} vs portal ${rec.expected}`);
  });

  it('the rental line is engine-owned so Save Override cannot double it', async () => {
    // A preserved rental row would survive the rebuild while the UI ALSO
    // recreates a Daily row from reservation.dailyRate — two rental lines.
    const { buildImportedQuoteRows } = await import('../integrations/mex/mex-reservation-detail.js');
    const rows = buildImportedQuoteRows(FAD4, { days: 10, taxRate: 11.5 });

    const base = rows.find((r) => r.code === 'DAILY');
    assert.equal(base.rate, 118);
    assert.equal(base.quantity, 10);
    assert.equal(base.total, 1180);
    assert.equal(base.source, 'BASE_RATE');
    assert.equal(base.taxable, true);
    assert.equal(isPreservedOnPricingRebuild(base), false, 'the rental must be rebuilt, not preserved');

    // Only the fees are MEX-owned — the one thing our engine cannot re-derive.
    const preserved = rows.filter((r) => isPreservedOnPricingRebuild(r));
    assert.deepEqual(preserved.map((r) => r.name).sort(),
      ['CUSTOMER FACILITY CHARGE', 'SURCHARGE', 'VEHICLE LICENSE FEE SJU']);
  });

  it('no tax rate means no invented tax row', async () => {
    const { buildImportedQuoteRows } = await import('../integrations/mex/mex-reservation-detail.js');
    for (const taxRate of [null, 0, undefined, NaN]) {
      const rows = buildImportedQuoteRows(FAD4, { days: 10, taxRate });
      assert.equal(rows.some((r) => r.chargeType === 'TAX'), false, `taxRate=${taxRate}`);
    }
  });

  it('the daily rate is derived from money ÷ days, not from the rate STRUCTURE', async () => {
    const { effectiveDailyRate } = await import('../integrations/mex/mex-reservation-detail.js');
    // "196.00/Month , 70.00/XDay" on 30 days bills 336.00 — neither 196 nor 70
    // is the daily rate; 336/30 = 11.20 is.
    assert.equal(effectiveDailyRate({ charges: { rateTotal: 336 } }, { days: 30 }), 11.2);
    assert.equal(effectiveDailyRate({ charges: { rateTotal: 1012 } }, { days: 4 }), 253);
    assert.equal(effectiveDailyRate({ charges: { rateTotal: 924 } }, { days: 11 }), 84);
    // No day count, no invented rate.
    assert.equal(effectiveDailyRate({ charges: { rateTotal: 924 } }, { days: null }), null);
    assert.equal(effectiveDailyRate({ charges: {} }, { days: 5 }), null);
  });

  it('a quote that does not add up says so instead of being shown as fact', async () => {
    const { quoteReconciliation } = await import('../integrations/mex/mex-reservation-detail.js');
    const bad = quoteReconciliation(
      [{ total: 100 }],
      { charges: { estimatedTotal: 1434.22 } },
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.expected, 1434.22);
    assert.equal(bad.actual, 100);
    assert.match(bad.reason, /do not reconcile/);
  });
});
