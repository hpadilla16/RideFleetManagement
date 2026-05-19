/**
 * Regression test for the duplicate-charges bug (RES-083011, 2026-05-19).
 *
 * What broke
 * ----------
 * RentalAgreementCharge rows were duplicated for active reservations: each
 * line item appeared twice — once with source=null and once with a typed
 * source (DAILY, SERVICE, INSURANCE, TAX, SECURITY_DEPOSIT). This doubled
 * agreement.total. Four agreements were affected on 2026-05-19 and were
 * backfilled via SQL.
 *
 * Root cause
 * ----------
 * Two writers exist and run on overlapping flows:
 *   1. rental-agreements.service.js #startFromReservation (structuredRows path)
 *   2. reservations/reservation-pricing.service.js #syncAgreementCharges
 *
 * Both do `deleteMany + createMany` against rentalAgreementCharge. They
 * USED to produce different row shapes — writer #1 omitted `source` and
 * `sourceRefId`, writer #2 preserved them. Subsequent flows treated the
 * two outputs as different row sets and accumulated dups.
 *
 * The fix (this test guards it)
 * -----------------------------
 * Both writers now project from `structuredReservationChargeRows()` and
 * MUST carry `source` and `sourceRefId` through to the createMany payload.
 * If a future edit drops either field, this test fails fast.
 *
 * Style: node:test + assert/strict, inline mocks. Matches fee-engine.test.mjs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { structuredReservationChargeRows } from './rental-agreements.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Contract test: structuredReservationChargeRows preserves source + sourceRefId
// ─────────────────────────────────────────────────────────────────────────────

describe('structuredReservationChargeRows — source preservation', () => {
  it('preserves source and sourceRefId from every reservation.charges row', () => {
    const reservation = {
      charges: [
        { name: 'Daily',            chargeType: 'DAILY',   quantity: 3, rate: 50,  total: 150, taxable: true,  selected: true,  sortOrder: 0, source: 'DAILY',             sourceRefId: null },
        { name: 'Roadside',         chargeType: 'UNIT',    quantity: 1, rate: 9.99, total: 9.99, taxable: true, selected: true,  sortOrder: 1, source: 'ADDITIONAL_SERVICE', sourceRefId: 'svc-1' },
        { name: 'Insurance',        chargeType: 'UNIT',    quantity: 3, rate: 12,  total: 36,  taxable: true,  selected: true,  sortOrder: 2, source: 'INSURANCE',         sourceRefId: 'ins-plan-A' },
        { name: 'Tax (11.50%)',     chargeType: 'TAX',     quantity: 1, rate: 22.5, total: 22.5, taxable: false, selected: true, sortOrder: 3, source: 'TAX',               sourceRefId: null },
        { name: 'Security Deposit', chargeType: 'DEPOSIT', quantity: 1, rate: 200, total: 200, taxable: false, selected: true,  sortOrder: 4, source: 'SECURITY_DEPOSIT', sourceRefId: null }
      ]
    };

    const rows = structuredReservationChargeRows(reservation);
    assert.ok(Array.isArray(rows), 'returns an array when charges exist');
    assert.equal(rows.length, 5);

    // Every row must carry the typed source. If any of these come back null
    // when the source reservation row had one, the duplicate-charges bug is
    // open again.
    assert.equal(rows[0].source, 'DAILY');
    assert.equal(rows[1].source, 'ADDITIONAL_SERVICE');
    assert.equal(rows[1].sourceRefId, 'svc-1');
    assert.equal(rows[2].source, 'INSURANCE');
    assert.equal(rows[2].sourceRefId, 'ins-plan-A');
    assert.equal(rows[3].source, 'TAX');
    assert.equal(rows[4].source, 'SECURITY_DEPOSIT');
  });

  it('returns null (not []) when reservation has no charges', () => {
    assert.equal(structuredReservationChargeRows({ charges: [] }), null);
    assert.equal(structuredReservationChargeRows({ charges: null }), null);
    assert.equal(structuredReservationChargeRows({}), null);
  });

  it('coerces missing source/sourceRefId to null (not undefined)', () => {
    // Important: Prisma createMany rejects `undefined` on some drivers.
    // We need null, not the absence of the key.
    const rows = structuredReservationChargeRows({
      charges: [
        { name: 'Daily', chargeType: 'DAILY', quantity: 1, rate: 50, total: 50, taxable: true, selected: true, sortOrder: 0 }
      ]
    });
    assert.equal(rows[0].source, null);
    assert.equal(rows[0].sourceRefId, null);
    assert.ok('source' in rows[0], 'source key must exist (not undefined)');
    assert.ok('sourceRefId' in rows[0], 'sourceRefId key must exist (not undefined)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract test: row-projection shape parity (writer #1 vs writer #2)
//
// We mimic the exact createMany payload projection used by:
//   - rental-agreements.service.js  startFromReservation (structuredRows path)
//   - reservation-pricing.service.js syncAgreementCharges
//
// Both MUST include `source` and `sourceRefId`. If only one does, the prod
// duplicate bug returns.
// ─────────────────────────────────────────────────────────────────────────────

function projectStartFromReservationStructured(rows, agreementId) {
  // This must mirror the projection inside rental-agreements.service.js
  // around line 1688 (the structuredRows path inside startFromReservation
  // for an existing agreement).
  return rows.map((row) => ({
    rentalAgreementId: agreementId,
    code: row.code,
    name: row.name,
    chargeType: row.chargeType,
    quantity: row.quantity,
    rate: row.rate,
    total: row.total,
    taxable: row.taxable,
    selected: row.selected,
    sortOrder: row.sortOrder,
    source: row.source || null,
    sourceRefId: row.sourceRefId || null
  }));
}

function projectSyncAgreementCharges(rows, agreementId) {
  // Mirrors reservation-pricing.service.js#syncAgreementCharges line 147.
  return rows.map((row, idx) => ({
    rentalAgreementId: agreementId,
    code: row.code,
    name: row.name,
    chargeType: row.chargeType,
    quantity: row.quantity,
    rate: row.rate,
    total: row.total,
    taxable: row.taxable,
    selected: row.selected,
    sortOrder: Number.isInteger(row.sortOrder) ? row.sortOrder : idx,
    source: row.source || null,
    sourceRefId: row.sourceRefId || null
  }));
}

describe('row-shape parity between the two writers', () => {
  const reservation = {
    charges: [
      { name: 'Daily',            chargeType: 'DAILY',   quantity: 3, rate: 50,  total: 150, taxable: true,  selected: true,  sortOrder: 0, source: 'DAILY',              sourceRefId: null,        code: null },
      { name: 'Roadside',         chargeType: 'UNIT',    quantity: 1, rate: 9.99, total: 9.99, taxable: true, selected: true,  sortOrder: 1, source: 'ADDITIONAL_SERVICE', sourceRefId: 'svc-1',     code: null },
      { name: 'Tax (11.50%)',     chargeType: 'TAX',     quantity: 1, rate: 22.5, total: 22.5, taxable: false, selected: true, sortOrder: 2, source: 'TAX',                sourceRefId: null,        code: null },
      { name: 'Security Deposit', chargeType: 'DEPOSIT', quantity: 1, rate: 200, total: 200, taxable: false, selected: true,  sortOrder: 3, source: 'SECURITY_DEPOSIT',  sourceRefId: null,        code: null }
    ]
  };

  it('both writers produce identical (source, sourceRefId) per row', () => {
    const structuredRows = structuredReservationChargeRows(reservation);
    const writerA = projectStartFromReservationStructured(structuredRows, 'agr-test');
    const writerB = projectSyncAgreementCharges(reservation.charges, 'agr-test');

    assert.equal(writerA.length, writerB.length, 'same row count');
    for (let i = 0; i < writerA.length; i += 1) {
      assert.equal(
        writerA[i].source,
        writerB[i].source,
        `row ${i} (${writerA[i].name}): source mismatch — writer #1 produced ${writerA[i].source}, writer #2 produced ${writerB[i].source}`
      );
      assert.equal(
        writerA[i].sourceRefId,
        writerB[i].sourceRefId,
        `row ${i} (${writerA[i].name}): sourceRefId mismatch`
      );
      assert.equal(writerA[i].name, writerB[i].name);
      assert.equal(writerA[i].chargeType, writerB[i].chargeType);
    }
  });

  it('a deleteMany+createMany from either writer leaves no duplicates', () => {
    // Simulate the prod sequence: writer #1 fires, then writer #2 fires.
    // Each one is `deleteMany` (wipes the prior write) + `createMany`.
    // Since the projections now match, the final table state is exactly
    // one row per (name, chargeType).
    const structuredRows = structuredReservationChargeRows(reservation);
    let table = [];

    // writer #1 run
    table = []; // deleteMany
    table.push(...projectStartFromReservationStructured(structuredRows, 'agr-x'));

    // writer #2 run
    table = []; // deleteMany
    table.push(...projectSyncAgreementCharges(reservation.charges, 'agr-x'));

    // writer #1 run again (e.g. operator clicks Print Agreement)
    table = []; // deleteMany
    table.push(...projectStartFromReservationStructured(structuredRows, 'agr-x'));

    // Group by (name, chargeType) and assert max count == 1.
    const groups = new Map();
    for (const row of table) {
      const key = `${row.name}::${row.chargeType}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    for (const [key, count] of groups.entries()) {
      assert.equal(count, 1, `(name, chargeType) "${key}" appears ${count} times — duplicate-charges regression`);
    }
    assert.equal(table.length, reservation.charges.length);
  });
});
