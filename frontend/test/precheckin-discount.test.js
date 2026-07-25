/**
 * Pre-check-in discount helpers for the Edit-pricing override UI (2026-07-25).
 *
 * THE BUG THESE PIN: the override UI rebuilds insurance/service rows from
 * catalog prices, so Save Override silently reverted the discounted price the
 * customer accepted at pre-check-in ($38 back to $40). These helpers detect the
 * portal's markers and re-apply the tenant discount — and their math MUST stay
 * byte-equal with backend/src/lib/precheckin-catalog.js makeDiscountFn, or the
 * override writes a different cent than the portal did.
 */
import { describe, it, expect } from 'vitest';
import {
  makeDiscountFn,
  hasPrecheckinDiscount,
  stripPrecheckinSuffix,
  precheckinNotes,
  PRECHECKIN_NAME_MARKER,
  PRECHECKIN_NOTES_MARKER,
} from '../src/lib/precheckin-discount';

describe('makeDiscountFn — mirrors the backend exactly', () => {
  it('PERCENTAGE: the reported case — 5% off $40 is $38, same as the portal wrote', () => {
    const fn = makeDiscountFn({ enabled: true, type: 'PERCENTAGE', value: 5 });
    expect(fn(40)).toBe(38);
    expect(fn(29.99)).toBe(28.49); // portal's rounding: toFixed(2) then Number
  });

  it('FIXED: subtracts and clamps at zero, never negative', () => {
    const fn = makeDiscountFn({ enabled: true, type: 'FIXED', value: 5 });
    expect(fn(40)).toBe(35);
    expect(fn(3)).toBe(0);
  });

  it('disabled / missing config is identity (rounded)', () => {
    for (const cfg of [null, undefined, { enabled: false, type: 'PERCENTAGE', value: 50 }]) {
      const fn = makeDiscountFn(cfg);
      expect(fn(40)).toBe(40);
      expect(fn(29.999)).toBe(30); // still rounds like the backend does
    }
  });

  it('zero amount stays zero — no discount invents money', () => {
    const fn = makeDiscountFn({ enabled: true, type: 'FIXED', value: 5 });
    expect(fn(0)).toBe(0);
  });
});

describe('hasPrecheckinDiscount — marker detection on live charges', () => {
  it('detects the notes marker the portal writes', () => {
    expect(hasPrecheckinDiscount([
      { name: 'Daily', notes: null },
      { name: 'CDW Zero', notes: 'Counter price: $40.00/day × 3 day(s), pre-checkin discount applied' },
    ])).toBe(true);
  });

  it('detects the name marker as a fallback', () => {
    expect(hasPrecheckinDiscount([{ name: `CDW Zero ${PRECHECKIN_NAME_MARKER}`, notes: null }])).toBe(true);
  });

  it('no marker → false; garbage input → false, never throws', () => {
    expect(hasPrecheckinDiscount([{ name: 'Daily', notes: 'plain note' }])).toBe(false);
    for (const bad of [null, undefined, [], {}, 'x', [null, {}]]) {
      expect(hasPrecheckinDiscount(bad)).toBe(false);
    }
  });
});

describe('stripPrecheckinSuffix — keeps catalog name-matching working', () => {
  it('strips the suffix the portal appends', () => {
    expect(stripPrecheckinSuffix('Toll Pass (Pre-checkin rate)')).toBe('Toll Pass');
    expect(stripPrecheckinSuffix('Toll Pass  (Pre-checkin rate) ')).toBe('Toll Pass');
  });
  it('leaves clean names alone, including parentheses that are not the marker', () => {
    expect(stripPrecheckinSuffix('Toll Pass')).toBe('Toll Pass');
    expect(stripPrecheckinSuffix('GPS (Garmin)')).toBe('GPS (Garmin)');
  });
});

describe('precheckinNotes — audit-trail format matches the portal', () => {
  it('appends the exact marker hasPrecheckinDiscount looks for', () => {
    const n = precheckinNotes('Counter price: $40.00/day × 3 day(s)');
    expect(n).toContain(PRECHECKIN_NOTES_MARKER);
    // The round-trip that keeps the discount alive across REPEATED overrides:
    // a row written with these notes must be detected next time.
    expect(hasPrecheckinDiscount([{ name: 'x', notes: n }])).toBe(true);
  });
});
