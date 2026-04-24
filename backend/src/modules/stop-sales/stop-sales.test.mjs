import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isStopSaleOverlapping } from './stop-sale-overlap.js';

// isStopSaleOverlapping is the pure overlap helper behind
// stopSalesService.vehicleTypesBlockedForRange. Unit-testing it in isolation
// gives us cheap coverage of the half-open interval math without needing
// a live database.

describe('isStopSaleOverlapping', () => {
  const baseSS = {
    isActive: true,
    startDate: new Date('2026-05-10T00:00:00Z'),
    endDate: new Date('2026-05-15T00:00:00Z')
  };

  it('returns true when rental fully inside stop-sale', () => {
    assert.equal(isStopSaleOverlapping(baseSS, '2026-05-11T00:00:00Z', '2026-05-13T00:00:00Z'), true);
  });

  it('returns true when stop-sale fully inside rental', () => {
    assert.equal(isStopSaleOverlapping(baseSS, '2026-05-01T00:00:00Z', '2026-05-20T00:00:00Z'), true);
  });

  it('returns true when rental start overlaps stop-sale end', () => {
    assert.equal(isStopSaleOverlapping(baseSS, '2026-05-14T00:00:00Z', '2026-05-20T00:00:00Z'), true);
  });

  it('returns true when rental end overlaps stop-sale start', () => {
    assert.equal(isStopSaleOverlapping(baseSS, '2026-05-05T00:00:00Z', '2026-05-11T00:00:00Z'), true);
  });

  it('returns false when rental ends exactly at stop-sale start (half-open)', () => {
    assert.equal(isStopSaleOverlapping(baseSS, '2026-05-05T00:00:00Z', '2026-05-10T00:00:00Z'), false);
  });

  it('returns false when rental starts exactly at stop-sale end (half-open)', () => {
    assert.equal(isStopSaleOverlapping(baseSS, '2026-05-15T00:00:00Z', '2026-05-20T00:00:00Z'), false);
  });

  it('returns false when rental is entirely before stop-sale', () => {
    assert.equal(isStopSaleOverlapping(baseSS, '2026-05-01T00:00:00Z', '2026-05-05T00:00:00Z'), false);
  });

  it('returns false when rental is entirely after stop-sale', () => {
    assert.equal(isStopSaleOverlapping(baseSS, '2026-05-20T00:00:00Z', '2026-05-25T00:00:00Z'), false);
  });

  it('returns false when stop-sale is inactive, even on overlap', () => {
    const inactive = { ...baseSS, isActive: false };
    assert.equal(isStopSaleOverlapping(inactive, '2026-05-11T00:00:00Z', '2026-05-13T00:00:00Z'), false);
  });

  it('returns false when inputs are missing or invalid', () => {
    assert.equal(isStopSaleOverlapping(null, '2026-05-11T00:00:00Z', '2026-05-13T00:00:00Z'), false);
    assert.equal(isStopSaleOverlapping(baseSS, null, '2026-05-13T00:00:00Z'), false);
    assert.equal(isStopSaleOverlapping(baseSS, '2026-05-11T00:00:00Z', null), false);
    assert.equal(isStopSaleOverlapping({ ...baseSS, startDate: 'nonsense' }, '2026-05-11T00:00:00Z', '2026-05-13T00:00:00Z'), false);
  });
});
