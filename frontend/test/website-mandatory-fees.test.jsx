import { describe, it, expect } from 'vitest';

// Pure helper for computing a single website-fee line total given the
// fee record, the pre-fee base amount, and the rental day count.
//
// This logic is DUPLICATED in frontend/src/app/book/page.js so the unit
// test can exercise it without mounting the 1866-line BookingPage under
// jsdom. If we ever extract it to a shared module, we should drop the
// duplication here and import it directly.
//
// Mirrors the backend's computeFeeTotal in reservation-pricing /
// rental-agreements services so front-end totals match back-end totals.
function computeFeeLineTotal(fee, { baseAmount = 0, days = 1 } = {}) {
  if (!fee) return 0;
  const amount = Number(fee.amount || 0);
  const mode = String(fee.mode || 'FIXED').toUpperCase();
  if (mode === 'PERCENTAGE') return Number((baseAmount * (amount / 100)).toFixed(2));
  if (mode === 'PER_DAY') return Number((amount * Math.max(1, Number(days || 1))).toFixed(2));
  return Number(amount.toFixed(2));
}

describe('website mandatory fees — line total computation', () => {
  it('FIXED mode returns the bare amount regardless of days or baseAmount', () => {
    expect(computeFeeLineTotal({ mode: 'FIXED', amount: 5 }, { baseAmount: 100, days: 3 })).toBe(5);
    expect(computeFeeLineTotal({ mode: 'FIXED', amount: 5 }, { baseAmount: 0, days: 1 })).toBe(5);
  });

  it('PERCENTAGE mode returns (baseAmount * amount/100)', () => {
    expect(computeFeeLineTotal({ mode: 'PERCENTAGE', amount: 10 }, { baseAmount: 100, days: 3 })).toBe(10);
    expect(computeFeeLineTotal({ mode: 'PERCENTAGE', amount: 7.5 }, { baseAmount: 200, days: 1 })).toBe(15);
  });

  it('PER_DAY mode multiplies by days with a minimum of 1', () => {
    expect(computeFeeLineTotal({ mode: 'PER_DAY', amount: 5 }, { baseAmount: 100, days: 3 })).toBe(15);
    expect(computeFeeLineTotal({ mode: 'PER_DAY', amount: 5 }, { baseAmount: 100, days: 0 })).toBe(5);
    expect(computeFeeLineTotal({ mode: 'PER_DAY', amount: 5 }, { baseAmount: 100 })).toBe(5);
  });

  it('is case-insensitive about mode', () => {
    expect(computeFeeLineTotal({ mode: 'fixed', amount: 3 }, { baseAmount: 100, days: 2 })).toBe(3);
    expect(computeFeeLineTotal({ mode: 'percentage', amount: 10 }, { baseAmount: 50, days: 1 })).toBe(5);
  });

  it('defaults mode to FIXED when missing', () => {
    expect(computeFeeLineTotal({ amount: 4 }, { baseAmount: 100, days: 3 })).toBe(4);
  });

  it('returns 0 for a null / undefined fee', () => {
    expect(computeFeeLineTotal(null, { baseAmount: 100, days: 1 })).toBe(0);
    expect(computeFeeLineTotal(undefined, { baseAmount: 100, days: 1 })).toBe(0);
  });

  it('coerces numeric-looking string amounts', () => {
    expect(computeFeeLineTotal({ mode: 'FIXED', amount: '2.5' }, { baseAmount: 100, days: 1 })).toBe(2.5);
  });
});

describe('website mandatory fees — total aggregation', () => {
  function sumWebsiteFees(fees, { baseAmount = 0, days = 1 } = {}) {
    return (fees || []).reduce((total, fee) => total + computeFeeLineTotal(fee, { baseAmount, days }), 0);
  }

  it('sums multiple fees across modes', () => {
    const fees = [
      { mode: 'FIXED', amount: 5 },
      { mode: 'PER_DAY', amount: 2 },
      { mode: 'PERCENTAGE', amount: 10 }
    ];
    expect(sumWebsiteFees(fees, { baseAmount: 100, days: 3 })).toBe(5 + 6 + 10);
  });

  it('returns 0 for empty or null fee lists', () => {
    expect(sumWebsiteFees([], { baseAmount: 100, days: 1 })).toBe(0);
    expect(sumWebsiteFees(null, { baseAmount: 100, days: 1 })).toBe(0);
  });
});
