import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreCandidate } from './tolls.service.js';

// Build a reservation that intentionally has NO formal checkout signal:
//   - status = CONFIRMED (not CHECKED_OUT)
//   - rentalAgreement.finalizedAt = null
//   - no checkout inspection
// This is the loaner-shaped reservation pattern that triggers
// dispatchConfirmationRequired = true under the current responsibility resolver.
function loanerStyleReservation(overrides = {}) {
  return {
    status: 'CONFIRMED',
    pickupAt: new Date('2026-04-07T10:00:00.000Z'),
    returnAt: new Date('2026-04-09T10:00:00.000Z'),
    vehicleId: 'veh-1',
    workflowMode: 'DEALERSHIP_LOANER',
    readyForPickupAt: new Date('2026-04-07T09:45:00.000Z'),
    rentalAgreement: {
      vehicleId: 'veh-1',
      finalizedAt: null,
      inspections: [],
      vehicleSwaps: []
    },
    ...overrides
  };
}

const VEH_BASE = {
  id: 'veh-1',
  internalNumber: 'L-101',
  plate: 'ABC123',
  tollTagNumber: 'TAG-9988',
  tollStickerNumber: 'SELLO-7711'
};

test('scoreCandidate without multi-signal override caps a loaner toll at 79 (dispatch gate)', () => {
  const reservation = loanerStyleReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: '',
    selloRaw: ''
  };

  const result = scoreCandidate({
    transaction,
    vehicle: VEH_BASE,
    reservation,
    siblingCandidates: 1
  });

  // Only one strong identifier (plate) — multi-signal override does NOT apply.
  assert.equal(result.multiSignalOverride, false, 'override should be off with 1 identifier');
  assert.equal(result.dispatchConfirmationRequired, true, 'dispatch flag stays on without override');
  assert.ok(result.score <= 79, `expected score capped at 79, got ${result.score}`);
});

test('scoreCandidate WITH multi-signal override (plate + tag) bypasses dispatch cap', () => {
  const reservation = loanerStyleReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: 'TAG-9988',
    selloRaw: ''
  };

  const result = scoreCandidate({
    transaction,
    vehicle: VEH_BASE,
    reservation,
    siblingCandidates: 1
  });

  assert.equal(result.multiSignalOverride, true, 'override should fire with 2 identifiers + windows');
  assert.equal(result.dispatchConfirmationRequired, false, 'dispatch flag suppressed by override');
  assert.equal(result.reviewCategory, null, 'reviewCategory cleared by override');
  assert.ok(
    result.score >= 85,
    `expected score >= 85 (auto-confirm) with multi-signal override, got ${result.score}`
  );
  assert.ok(
    result.matchReason.includes('multiSignalOverride'),
    `expected matchReason to include multiSignalOverride token, got "${result.matchReason}"`
  );
});

test('scoreCandidate multi-signal override requires inside-trip-window', () => {
  const reservation = loanerStyleReservation();
  // Toll fires before the trip window (and outside the responsibility window)
  const transaction = {
    transactionAt: new Date('2026-04-05T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: 'TAG-9988',
    selloRaw: ''
  };

  const result = scoreCandidate({
    transaction,
    vehicle: VEH_BASE,
    reservation,
    siblingCandidates: 1
  });

  // Even with both identifiers matching, no trip-window means no override.
  assert.equal(result.multiSignalOverride, false, 'override should NOT fire outside trip window');
});

test('scoreCandidate multi-signal override with three identifiers maxes confidence', () => {
  const reservation = loanerStyleReservation();
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: 'TAG-9988',
    selloRaw: 'SELLO-7711'
  };

  const result = scoreCandidate({
    transaction,
    vehicle: VEH_BASE,
    reservation,
    siblingCandidates: 1
  });

  assert.equal(result.multiSignalOverride, true);
  assert.equal(result.dispatchConfirmationRequired, false);
  assert.ok(result.score >= 85, `expected auto-confirm-grade score, got ${result.score}`);
});

test('scoreCandidate without dispatch-confirmation-needed reservation behaves identically (regression)', () => {
  // status = CHECKED_OUT means no dispatch-confirmation gate is triggered at all.
  // The override path should be a no-op here — current behavior must be preserved.
  const reservation = loanerStyleReservation({
    status: 'CHECKED_OUT',
    rentalAgreement: {
      vehicleId: 'veh-1',
      finalizedAt: new Date('2026-04-07T10:00:00.000Z'),
      inspections: [],
      vehicleSwaps: []
    }
  });
  const transaction = {
    transactionAt: new Date('2026-04-07T12:00:00.000Z'),
    plateRaw: 'ABC123',
    tagRaw: 'TAG-9988',
    selloRaw: ''
  };

  const result = scoreCandidate({
    transaction,
    vehicle: VEH_BASE,
    reservation,
    siblingCandidates: 1
  });

  assert.equal(result.dispatchConfirmationRequired, false, 'no dispatch gate when reservation is checked out');
  assert.ok(result.score >= 85, 'should auto-confirm for a normal checked-out match');
});
