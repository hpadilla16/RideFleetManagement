/**
 * Revenue by Vehicle Type — the attribution rules, without a database.
 *
 * These cover the three things that would be wrong in a way nobody notices:
 * tax and deposits leaking into revenue, a rental being counted once per
 * charge instead of once per rental, and revenue from an agreement with no
 * vehicle silently vanishing instead of being reported.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, rentalDays } from './revenue-by-vehicle-type.math.js';

const TYPE_A = { id: 'ta', code: 'CCAR', name: 'Compact' };
const TYPE_B = { id: 'tb', code: 'MVAR', name: 'Minivan' };

function charge(agreementId, type, chargeType, total, opts = {}) {
  return {
    chargeType,
    total,
    rentalAgreement: {
      id: agreementId,
      pickupAt: opts.pickupAt || '2026-09-01T14:00:00Z',
      returnAt: opts.returnAt || '2026-09-04T14:00:00Z',
      vehicle: type ? { id: `v-${type.id}`, vehicleType: type } : null,
    },
  };
}

describe('rentalDays', () => {
  it('counts a same-day rental as one day, never zero', () => {
    assert.equal(rentalDays('2026-09-01T09:00:00Z', '2026-09-01T17:00:00Z'), 1);
  });

  it('rounds a partial day up, the way a rental is billed', () => {
    assert.equal(rentalDays('2026-09-01T14:00:00Z', '2026-09-04T18:00:00Z'), 4);
  });

  it('falls back to one day rather than NaN on a bad date', () => {
    assert.equal(rentalDays('not a date', '2026-09-04T14:00:00Z'), 1);
  });
});

describe('aggregate — what counts as revenue', () => {
  it('keeps tax and deposits out of revenue but still reports them', () => {
    const out = aggregate([
      charge('a1', TYPE_A, 'UNIT', 300),
      charge('a1', TYPE_A, 'TAX', 34.5),
      charge('a1', TYPE_A, 'DEPOSIT', 250),
    ]);
    assert.equal(out.totals.revenue, 300);
    assert.equal(out.totals.taxAmount, 34.5);
    assert.equal(out.totals.depositAmount, 250);
    assert.equal(out.rows[0].revenue, 300);
  });

  it('counts a rental once however many charges it carries', () => {
    const out = aggregate([
      charge('a1', TYPE_A, 'UNIT', 100),
      charge('a1', TYPE_A, 'UNIT', 50),
      charge('a1', TYPE_A, 'UNIT', 25),
    ]);
    assert.equal(out.rows[0].rentals, 1, 'three charges are one rental');
    assert.equal(out.rows[0].revenue, 175);
    assert.equal(out.rows[0].days, 3, 'days must not be counted per charge either');
  });

  it('does not let a tax-only agreement invent a rental', () => {
    const out = aggregate([charge('a1', TYPE_A, 'TAX', 10)]);
    assert.equal(out.totals.rentals, 0);
  });
});

describe('aggregate — attribution', () => {
  it('splits revenue by the vehicle type actually on the agreement', () => {
    const out = aggregate([
      charge('a1', TYPE_A, 'UNIT', 100),
      charge('a2', TYPE_B, 'UNIT', 400),
    ]);
    const byCode = Object.fromEntries(out.rows.map((r) => [r.code, r.revenue]));
    assert.deepEqual(byCode, { CCAR: 100, MVAR: 400 });
  });

  it('reports revenue with no vehicle instead of dropping it', () => {
    const out = aggregate([
      charge('a1', TYPE_A, 'UNIT', 100),
      charge('a2', null, 'UNIT', 60),
    ]);
    assert.equal(out.rows.length, 1, 'unassigned is not a type row');
    assert.ok(out.unassigned, 'unassigned block exists');
    assert.equal(out.unassigned.revenue, 60);
    assert.equal(out.totals.revenue, 160, 'but it still counts in the total');
  });

  it('never charges unassigned revenue a revenue-per-unit', () => {
    const out = aggregate([charge('a1', null, 'UNIT', 60)]);
    assert.equal(out.unassigned.revenuePerUnit, null);
  });
});

describe('aggregate — per-unit economics', () => {
  it('divides by fleet size, so the small high-earning type wins', () => {
    // Thirty compacts out-earn four minivans in total and lose per car. That
    // inversion is the entire point of the report.
    const charges = [];
    for (let i = 0; i < 30; i += 1) charges.push(charge(`c${i}`, TYPE_A, 'UNIT', 100));
    for (let i = 0; i < 4; i += 1) charges.push(charge(`m${i}`, TYPE_B, 'UNIT', 500));
    const out = aggregate(charges, new Map([[TYPE_A.id, 30], [TYPE_B.id, 4]]));

    const compact = out.rows.find((r) => r.code === 'CCAR');
    const minivan = out.rows.find((r) => r.code === 'MVAR');
    assert.equal(compact.revenue, 3000);
    assert.equal(minivan.revenue, 2000);
    assert.equal(compact.revenuePerUnit, 100);
    assert.equal(minivan.revenuePerUnit, 500);
    assert.equal(out.rows[0].code, 'MVAR', 'sorted by revenue per unit, not total');
  });

  it('says null, not zero, when the type has no units on the books', () => {
    const out = aggregate([charge('a1', TYPE_A, 'UNIT', 100)], new Map());
    assert.equal(out.rows[0].revenuePerUnit, null);
    assert.equal(out.rows[0].units, 0);
  });

  it('computes share of total revenue', () => {
    const out = aggregate([
      charge('a1', TYPE_A, 'UNIT', 250),
      charge('a2', TYPE_B, 'UNIT', 750),
    ]);
    const byCode = Object.fromEntries(out.rows.map((r) => [r.code, r.sharePct]));
    assert.equal(byCode.CCAR, 25);
    assert.equal(byCode.MVAR, 75);
  });

  it('handles an empty range without dividing by zero', () => {
    const out = aggregate([]);
    assert.deepEqual(out.rows, []);
    assert.equal(out.totals.revenue, 0);
    assert.equal(out.unassigned, null);
  });
});
