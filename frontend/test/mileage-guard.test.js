/**
 * Counter-UX Item 2 (2026-08-31) — the check-in mileage guard.
 *
 * The check-in odometer is pre-filled with the last known mileage; entering
 * LESS than the check-out reading must WARN inline but NEVER block (odometer
 * swaps/corrections exist — the correct-readings module is the precedent).
 */
import { describe, it, expect } from 'vitest';
import { mileageGuard } from '../src/lib/mileage-guard.js';

describe('mileageGuard', () => {
  it('warns when the entered reading is below the check-out baseline', () => {
    expect(mileageGuard({ entered: '44900', baseline: 45210 })).toEqual({ warn: true, delta: -310 });
    expect(mileageGuard({ entered: 1, baseline: 45210 })).toEqual({ warn: true, delta: -45209 });
  });

  it('does not warn at or above the baseline', () => {
    expect(mileageGuard({ entered: '45210', baseline: 45210 })).toEqual({ warn: false, delta: 0 });
    expect(mileageGuard({ entered: '45500', baseline: 45210 })).toEqual({ warn: false, delta: 290 });
  });

  it('stays quiet while nothing is entered yet', () => {
    expect(mileageGuard({ entered: '', baseline: 45210 }).warn).toBe(false);
    expect(mileageGuard({ entered: '   ', baseline: 45210 }).warn).toBe(false);
    expect(mileageGuard({ entered: null, baseline: 45210 }).warn).toBe(false);
    expect(mileageGuard({ entered: undefined, baseline: 45210 }).warn).toBe(false);
  });

  it('stays quiet without a usable baseline (no check-out reading)', () => {
    expect(mileageGuard({ entered: '100', baseline: 0 }).warn).toBe(false);
    expect(mileageGuard({ entered: '100', baseline: null }).warn).toBe(false);
    expect(mileageGuard({ entered: '100', baseline: undefined }).warn).toBe(false);
    expect(mileageGuard({ entered: '100', baseline: 'n/a' }).warn).toBe(false);
  });

  it('non-numeric entry never warns (the >0 gate handles it elsewhere)', () => {
    expect(mileageGuard({ entered: 'abc', baseline: 45210 }).warn).toBe(false);
  });

  it('is a warning, not a block: the result carries no blocking flag', () => {
    const out = mileageGuard({ entered: '10', baseline: 45210 });
    expect(Object.keys(out).sort()).toEqual(['delta', 'warn']);
  });
});
