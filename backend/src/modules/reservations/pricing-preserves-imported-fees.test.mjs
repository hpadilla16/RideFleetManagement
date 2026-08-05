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
import {
  isExternallyOwnedCharge,
  isPreservedOnPricingRebuild,
  EXTERNALLY_OWNED_CHARGE_SOURCES,
} from './reservation-pricing.service.js';
import { buildImportedFeeRows, MEX_CHARGE_SOURCE } from '../integrations/mex/mex-reservation-detail.js';

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
    assert.equal(rows.every((r) => r.taxable === false), true,
      'the portal reports Est Tax Total separately — taxing these again invents money');
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
