/**
 * Unit tests for fee engine pure-compute functions.
 *
 * These tests cover the math without touching the DB. Persistence tests
 * (computeCheckinFees with persist=true) live in a separate integration test
 * because they require a real Prisma client + test DB.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeExcessMileage,
  computeFuelRefill,
  computeCleaningFee,
  computeSmokingFee,
  computeLateReturnFee,
  LATE_RETURN_GRACE_MINUTES,
  feeEngineService
} from './fee-engine.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// computeExcessMileage
// ─────────────────────────────────────────────────────────────────────────────

describe('computeExcessMileage', () => {
  const rate = { amount: 0.50 };

  it('returns null when no excess', () => {
    const result = computeExcessMileage({
      odometerOut: 10000, odometerIn: 10150, includedMiles: 200, rate
    });
    assert.equal(result, null);
  });

  it('charges only the excess miles, not total driven', () => {
    const result = computeExcessMileage({
      odometerOut: 10000, odometerIn: 10300, includedMiles: 200, rate
    });
    assert.equal(result.quantity, 100);
    assert.equal(result.total, 50);
  });

  it('returns null when delta is negative or zero (defensive)', () => {
    assert.equal(computeExcessMileage({ odometerOut: 10000, odometerIn: 9900, includedMiles: 200, rate }), null);
    assert.equal(computeExcessMileage({ odometerOut: 10000, odometerIn: 10000, includedMiles: 200, rate }), null);
  });

  it('handles 0 included miles (uncommon but valid)', () => {
    const result = computeExcessMileage({
      odometerOut: 10000, odometerIn: 10050, includedMiles: 0, rate
    });
    assert.equal(result.quantity, 50);
    assert.equal(result.total, 25);
  });

  it('description contains driven mile count', () => {
    const result = computeExcessMileage({
      odometerOut: 10000, odometerIn: 10500, includedMiles: 200, rate
    });
    assert.match(result.description, /300/);  // 500 - 200 = 300 excess
    assert.match(result.description, /200/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeFuelRefill
// ─────────────────────────────────────────────────────────────────────────────

describe('computeFuelRefill', () => {
  const rate = { amount: 7.00 };

  it('returns null when fuel returned equal or higher than pickup', () => {
    assert.equal(computeFuelRefill({ fuelOut: 0.75, fuelIn: 1.00, tankCapacityGallons: 15, rate }), null);
    assert.equal(computeFuelRefill({ fuelOut: 0.75, fuelIn: 0.75, tankCapacityGallons: 15, rate }), null);
  });

  it('charges per gallon when returned below pickup', () => {
    const result = computeFuelRefill({
      fuelOut: 1.00, fuelIn: 0.50, tankCapacityGallons: 15, rate
    });
    // gap = 0.5, gallons = 7.5, total = 7.5 * 7 = 52.5
    assert.equal(result.quantity, 7.5);
    assert.equal(result.total, 52.5);
  });

  it('handles partial tank pickup correctly', () => {
    const result = computeFuelRefill({
      fuelOut: 0.5, fuelIn: 0.25, tankCapacityGallons: 12, rate
    });
    // gap = 0.25, gallons = 3, total = 3 * 7 = 21
    assert.equal(result.quantity, 3);
    assert.equal(result.total, 21);
  });

  it('rounds to 2 decimal places', () => {
    const result = computeFuelRefill({
      fuelOut: 0.95, fuelIn: 0.42, tankCapacityGallons: 13.7, rate
    });
    // gap = 0.53, gallons = 0.53 * 13.7 = 7.261, rounded to 7.26
    assert.equal(result.quantity, 7.26);
  });

  it('description shows return fuel as percent', () => {
    const result = computeFuelRefill({
      fuelOut: 1.00, fuelIn: 0.25, tankCapacityGallons: 15, rate
    });
    assert.match(result.description, /25%/);
    assert.match(result.description, /100%/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeCleaningFee
// ─────────────────────────────────────────────────────────────────────────────

describe('computeCleaningFee', () => {
  const ratesByTier = {
    CLEANING_LIGHT:  { amount: 50 },
    CLEANING_MEDIUM: { amount: 100 },
    CLEANING_HEAVY:  { amount: 200 }
  };

  it('returns null when cleanliness unchanged or improved', () => {
    assert.equal(computeCleaningFee({ cleanlinessOut: 5, cleanlinessIn: 5, ratesByTier }), null);
    assert.equal(computeCleaningFee({ cleanlinessOut: 3, cleanlinessIn: 4, ratesByTier }), null);
  });

  it('charges LIGHT for 1-tier drop', () => {
    const result = computeCleaningFee({ cleanlinessOut: 5, cleanlinessIn: 4, ratesByTier });
    assert.equal(result.feeType, 'CLEANING_LIGHT');
    assert.equal(result.total, 50);
  });

  it('charges MEDIUM for 2-tier drop', () => {
    const result = computeCleaningFee({ cleanlinessOut: 5, cleanlinessIn: 3, ratesByTier });
    assert.equal(result.feeType, 'CLEANING_MEDIUM');
    assert.equal(result.total, 100);
  });

  it('charges HEAVY for 3+ tier drop', () => {
    const result1 = computeCleaningFee({ cleanlinessOut: 5, cleanlinessIn: 2, ratesByTier });
    assert.equal(result1.feeType, 'CLEANING_HEAVY');
    assert.equal(result1.total, 200);

    const result2 = computeCleaningFee({ cleanlinessOut: 5, cleanlinessIn: 1, ratesByTier });
    assert.equal(result2.feeType, 'CLEANING_HEAVY');
    assert.equal(result2.total, 200);
  });

  it('returns null when either side is missing', () => {
    assert.equal(computeCleaningFee({ cleanlinessOut: 0, cleanlinessIn: 3, ratesByTier }), null);
    assert.equal(computeCleaningFee({ cleanlinessOut: 5, cleanlinessIn: 0, ratesByTier }), null);
  });

  it('description includes both ratings', () => {
    const result = computeCleaningFee({ cleanlinessOut: 5, cleanlinessIn: 2, ratesByTier });
    assert.match(result.description, /5\/5/);
    assert.match(result.description, /2\/5/);
    assert.match(result.description, /heavy/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeSmokingFee
// ─────────────────────────────────────────────────────────────────────────────

describe('computeSmokingFee', () => {
  const rate = { amount: 250 };

  it('returns null when no smoking detected', () => {
    assert.equal(computeSmokingFee({ smokingDetected: false, rate }), null);
    assert.equal(computeSmokingFee({ smokingDetected: undefined, rate }), null);
  });

  it('charges flat smoking fee when detected', () => {
    const result = computeSmokingFee({ smokingDetected: true, rate });
    assert.equal(result.quantity, 1);
    assert.equal(result.total, 250);
  });

  it('description is descriptive (for invoice line item)', () => {
    const result = computeSmokingFee({ smokingDetected: true, rate });
    assert.match(result.description, /smoking|tobacco/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeLateReturnFee
// ─────────────────────────────────────────────────────────────────────────────

describe('computeLateReturnFee', () => {
  const rate = { amount: 25.00 };
  const grace = 30;  // mirror LATE_RETURN_GRACE_MINUTES for legibility

  // anchor date used across tests
  const due = new Date('2026-05-18T15:00:00.000Z');
  const plus = (minutes) => new Date(due.getTime() + minutes * 60000);

  it('exports the expected grace constant (30 min)', () => {
    assert.equal(LATE_RETURN_GRACE_MINUTES, 30);
  });

  it('returns null when returnedAt equals dueBackAt (on-time)', () => {
    assert.equal(computeLateReturnFee({ dueBackAt: due, returnedAt: due, graceMinutes: grace, rate }), null);
  });

  it('returns null when 15 min late (under grace)', () => {
    assert.equal(computeLateReturnFee({ dueBackAt: due, returnedAt: plus(15), graceMinutes: grace, rate }), null);
  });

  it('returns null when exactly at grace boundary (30 min late)', () => {
    // 30 - 30 = 0 billable minutes → ceil(0/60) = 0 hours → null
    assert.equal(computeLateReturnFee({ dueBackAt: due, returnedAt: plus(30), graceMinutes: grace, rate }), null);
  });

  it('charges 1 hour when 35 min late (5 min past grace)', () => {
    const result = computeLateReturnFee({ dueBackAt: due, returnedAt: plus(35), graceMinutes: grace, rate });
    assert.equal(result.quantity, 1);
    assert.equal(result.rate, 25);
    assert.equal(result.total, 25);
  });

  it('charges 2 hours when 2h 10m late (1h 40m past grace)', () => {
    // minutesLate = 130, billable = 100, ceil(100/60) = 2
    const result = computeLateReturnFee({ dueBackAt: due, returnedAt: plus(130), graceMinutes: grace, rate });
    assert.equal(result.quantity, 2);
    assert.equal(result.total, 50);
  });

  it('rounds partial hours UP (ceil) — 91 min past grace = 2 hours', () => {
    // 91 min over grace → ceil(91/60) = 2 hours
    const result = computeLateReturnFee({ dueBackAt: due, returnedAt: plus(grace + 91), graceMinutes: grace, rate });
    assert.equal(result.quantity, 2);
    assert.equal(result.total, 50);
  });

  it('returns null when dueBackAt is in the future (returned before due)', () => {
    const result = computeLateReturnFee({ dueBackAt: plus(60), returnedAt: due, graceMinutes: grace, rate });
    assert.equal(result, null);
  });

  it('returns null when dueBackAt is missing (defensive)', () => {
    assert.equal(computeLateReturnFee({ dueBackAt: null, returnedAt: due, graceMinutes: grace, rate }), null);
    assert.equal(computeLateReturnFee({ dueBackAt: undefined, returnedAt: due, graceMinutes: grace, rate }), null);
  });

  it('returns null when returnedAt is missing (defensive)', () => {
    assert.equal(computeLateReturnFee({ dueBackAt: due, returnedAt: null, graceMinutes: grace, rate }), null);
  });

  it('returns null when either date is unparseable (defensive)', () => {
    assert.equal(computeLateReturnFee({ dueBackAt: 'not-a-date', returnedAt: due, graceMinutes: grace, rate }), null);
  });

  it('accepts ISO date strings (not just Date objects)', () => {
    const result = computeLateReturnFee({
      dueBackAt: '2026-05-18T15:00:00.000Z',
      returnedAt: '2026-05-18T16:00:00.000Z',  // 60 min late, 30 over grace
      graceMinutes: grace,
      rate
    });
    assert.equal(result.quantity, 1);
    assert.equal(result.total, 25);
  });

  it('uses default grace (30 min) when not passed explicitly', () => {
    // 25 min late, no graceMinutes arg → default 30 → under grace → null
    assert.equal(computeLateReturnFee({ dueBackAt: due, returnedAt: plus(25), rate }), null);
    // 90 min late, default grace → billable 60 min → ceil(60/60) = 1 hour
    const result = computeLateReturnFee({ dueBackAt: due, returnedAt: plus(90), rate });
    assert.equal(result.quantity, 1);
  });

  it('description references billable hours and grace window', () => {
    const result = computeLateReturnFee({ dueBackAt: due, returnedAt: plus(35), graceMinutes: grace, rate });
    assert.match(result.description, /2 hour|1 hour/);
    assert.match(result.description, /30-minute/);
  });

  it('honors tenant override rate (custom amount)', () => {
    // Simulates the case where resolveRate returned a per-tenant FeeRate row
    // with a non-default amount (e.g., $40/hr instead of the hardcoded $25).
    const overrideRate = { amount: 40.00 };
    const result = computeLateReturnFee({ dueBackAt: due, returnedAt: plus(90), graceMinutes: grace, rate: overrideRate });
    assert.equal(result.quantity, 1);
    assert.equal(result.rate, 40);
    assert.equal(result.total, 40);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HARDCODED_RATES fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('HARDCODED_RATES', () => {
  it('exposes LATE_RETURN with PER_HOUR unit and $25 default', () => {
    const fb = feeEngineService.HARDCODED_RATES.LATE_RETURN;
    assert.ok(fb, 'LATE_RETURN entry should exist');
    assert.equal(fb.unit, 'PER_HOUR');
    assert.equal(fb.amount, 25.00);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Realistic scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe('realistic scenarios', () => {
  const mileageRate = { amount: 0.50 };
  const fuelRate = { amount: 7.00 };
  const cleaningRates = {
    CLEANING_LIGHT:  { amount: 50 },
    CLEANING_MEDIUM: { amount: 100 },
    CLEANING_HEAVY:  { amount: 200 }
  };
  const smokingRate = { amount: 250 };

  it('clean return — no fees at all', () => {
    const mileage = computeExcessMileage({ odometerOut: 50000, odometerIn: 50150, includedMiles: 200, rate: mileageRate });
    const fuel = computeFuelRefill({ fuelOut: 1.0, fuelIn: 1.0, tankCapacityGallons: 15, rate: fuelRate });
    const cleaning = computeCleaningFee({ cleanlinessOut: 5, cleanlinessIn: 5, ratesByTier: cleaningRates });
    const smoking = computeSmokingFee({ smokingDetected: false, rate: smokingRate });
    assert.equal(mileage, null);
    assert.equal(fuel, null);
    assert.equal(cleaning, null);
    assert.equal(smoking, null);
  });

  it('worst case — over miles, no fuel, filthy, smoking', () => {
    const mileage = computeExcessMileage({ odometerOut: 50000, odometerIn: 50800, includedMiles: 200, rate: mileageRate });
    const fuel = computeFuelRefill({ fuelOut: 1.0, fuelIn: 0.1, tankCapacityGallons: 15, rate: fuelRate });
    const cleaning = computeCleaningFee({ cleanlinessOut: 5, cleanlinessIn: 1, ratesByTier: cleaningRates });
    const smoking = computeSmokingFee({ smokingDetected: true, rate: smokingRate });
    // 600 excess miles * 0.50 = 300
    assert.equal(mileage.total, 300);
    // 0.9 * 15 = 13.5 gal * 7 = 94.5
    assert.equal(fuel.total, 94.5);
    // cleanliness 5 → 1 = 4-tier drop = HEAVY = 200
    assert.equal(cleaning.total, 200);
    // smoking = 250
    assert.equal(smoking.total, 250);
    // grand total = 844.5
    assert.equal(mileage.total + fuel.total + cleaning.total + smoking.total, 844.5);
  });
});
