import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMismatch, canCompleteSession, computeTotals, MISMATCH } from './inventory-logic.js';

const NOW = new Date('2026-06-09T12:00:00Z');
const PAST = new Date('2026-06-06T12:00:00Z');
const FUTURE = new Date('2026-06-12T12:00:00Z');

describe('detectMismatch', () => {
  it('ON_RENT with an overdue checkout → ON_RENT_OVERDUE', () => {
    assert.equal(detectMismatch({ status: 'ON_RENT', checkedOutReservation: { returnAt: PAST } }, NOW), MISMATCH.ON_RENT_OVERDUE);
  });
  it('ON_RENT with a not-yet-due checkout → null (legit on rent)', () => {
    assert.equal(detectMismatch({ status: 'ON_RENT', checkedOutReservation: { returnAt: FUTURE } }, NOW), null);
  });
  it('ON_RENT with no checkout → null (the sweep handles pure drift)', () => {
    assert.equal(detectMismatch({ status: 'ON_RENT', checkedOutReservation: null }, NOW), null);
  });
  it('AVAILABLE with a checkout → SHOULD_BE_ON_RENT', () => {
    assert.equal(detectMismatch({ status: 'AVAILABLE', checkedOutReservation: { returnAt: FUTURE } }, NOW), MISMATCH.SHOULD_BE_ON_RENT);
  });
  it('AVAILABLE with no checkout → null', () => {
    assert.equal(detectMismatch({ status: 'AVAILABLE', checkedOutReservation: null }, NOW), null);
  });
  it('IN_MAINTENANCE is never a mismatch here', () => {
    assert.equal(detectMismatch({ status: 'IN_MAINTENANCE', checkedOutReservation: { returnAt: PAST } }, NOW), null);
  });
});

describe('canCompleteSession', () => {
  it('blocks when an item is still pending', () => {
    const r = canCompleteSession([{ state: 'CONFIRMED' }, { state: 'PENDING' }]);
    assert.equal(r.ok, false);
    assert.equal(r.pending, 1);
  });
  it('blocks when a mismatch is unresolved', () => {
    const r = canCompleteSession([{ state: 'CONFIRMED', mismatchType: 'ON_RENT_OVERDUE', mismatchResolved: false }]);
    assert.equal(r.ok, false);
    assert.equal(r.unresolvedMismatches, 1);
  });
  it('passes when all done and mismatches resolved', () => {
    const r = canCompleteSession([
      { state: 'CONFIRMED' },
      { state: 'EXCEPTION' },
      { state: 'CONFIRMED', mismatchType: 'ON_RENT_OVERDUE', mismatchResolved: true },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.reasons, []);
  });
  it('empty session is completable', () => {
    assert.equal(canCompleteSession([]).ok, true);
  });
});

describe('computeTotals', () => {
  it('counts states, mismatches, and located buckets', () => {
    const t = computeTotals([
      { state: 'CONFIRMED', locatedStatus: 'AT_LOT' },
      { state: 'CONFIRMED', locatedStatus: 'IN_MAINTENANCE' },
      { state: 'EXCEPTION', locatedStatus: 'NOT_FOUND' },
      { state: 'PENDING' },
      { state: 'CONFIRMED', locatedStatus: 'ON_RENT', mismatchType: 'ON_RENT_OVERDUE', mismatchResolved: true },
      { state: 'PENDING', mismatchType: 'SHOULD_BE_ON_RENT', mismatchResolved: false },
    ]);
    assert.equal(t.total, 6);
    assert.equal(t.confirmed, 3);
    assert.equal(t.exception, 1);
    assert.equal(t.pending, 2);
    assert.equal(t.atLot, 1);
    assert.equal(t.maintenance, 1);
    assert.equal(t.onRent, 1);
    assert.equal(t.mismatches, 2);
    assert.equal(t.mismatchesResolved, 1);
  });
});
