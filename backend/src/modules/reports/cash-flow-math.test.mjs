/**
 * Cash-flow forecasting math — DB-FREE.
 *
 * The two claims a forecast has to earn:
 *   1. committed money and guessed money never blend;
 *   2. money already collected is never forecast again.
 * Everything here defends one of those.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  weekdayRunRate,
  buildForecastSeries,
  confidenceFor,
  expectedInflow,
  committedByDayFrom,
  splitExpectedMoney,
  summarize,
  addIsoDays,
  weekdayOf,
} from './cash-flow-math.js';

// 2026-08-03 is a Monday.
const MON = '2026-08-03';

test('date helpers are UTC-stable', () => {
  assert.equal(addIsoDays(MON, 1), '2026-08-04');
  assert.equal(addIsoDays(MON, -3), '2026-07-31');
  assert.equal(weekdayOf(MON), 1, 'Monday');
  assert.equal(weekdayOf('2026-08-08'), 6, 'Saturday');
});

test('weekdayRunRate averages per weekday and counts zero days as data', () => {
  const history = [
    { iso: '2026-07-27', collected: 1000 }, // Mon
    { iso: '2026-08-03', collected: 2000 }, // Mon
    { iso: '2026-08-01', collected: 5000 }, // Sat
    { iso: '2026-07-28', collected: 0 },    // Tue — a dead Tuesday IS information
  ];
  const r = weekdayRunRate(history, { asOf: '2026-08-07' });
  assert.equal(r.byWeekday[1], 1500, 'Mondays average 1500');
  assert.equal(r.byWeekday[6], 5000, 'Saturdays');
  assert.equal(r.byWeekday[2], 0, 'a zero Tuesday averages 0, not null');
  assert.equal(r.byWeekday[0], null, 'a weekday never observed is null, never 0');
  assert.equal(r.sampleDays, 4);
});

test('run-rate ignores days outside the trailing window', () => {
  const r = weekdayRunRate(
    [{ iso: '2026-01-05', collected: 99999 }, { iso: '2026-08-03', collected: 100 }],
    { weeks: 8, asOf: '2026-08-07' },
  );
  assert.equal(r.byWeekday[1], 100, 'January cannot drag August');
  assert.equal(r.sampleDays, 1);
});

test('THE SUBTRACTION: committed money is not double-counted by the projection', () => {
  // Mondays average $2,000. Next Monday already has $1,200 booked.
  const runRate = { byWeekday: [null, 2000, null, null, null, null, null], overall: 2000 };
  const series = buildForecastSeries({
    startIso: '2026-08-10', // a Monday
    days: 1,
    committedByDay: new Map([['2026-08-10', 1200]]),
    runRate,
  });
  assert.equal(series[0].committed, 1200);
  assert.equal(series[0].projected, 800, 'only the gap is projected — not another 2000');
  assert.equal(series[0].total, 2000, 'the total stays the weekday expectation');
});

test('a day already booked ABOVE its average projects nothing extra', () => {
  const runRate = { byWeekday: [null, 2000, null, null, null, null, null], overall: 2000 };
  const [day] = buildForecastSeries({
    startIso: '2026-08-10', days: 1,
    committedByDay: { '2026-08-10': 3500 }, runRate,
  });
  assert.equal(day.projected, 0, 'never negative, never subtracting from a real booking');
  assert.equal(day.total, 3500, 'the committed number stands on its own');
});

test('confidence decays with distance and the projection decays with it', () => {
  assert.equal(confidenceFor(1), 1);
  assert.equal(confidenceFor(7), 1, 'the first week is fully trusted');
  assert.ok(confidenceFor(30) < 1 && confidenceFor(30) > confidenceFor(60));
  assert.equal(confidenceFor(90), 0.35, 'floors, never reaches zero');

  const runRate = { byWeekday: Array(7).fill(1000), overall: 1000 };
  const series = buildForecastSeries({ startIso: '2026-08-10', days: 60, committedByDay: new Map(), runRate });
  assert.equal(series[0].projected, 1000, 'tomorrow is the full run-rate');
  assert.ok(series[45].projected < series[0].projected, 'six weeks out is discounted');
  assert.ok(series[45].projected > 0, 'but never written off');
});

test('with no history at all the forecast projects NOTHING rather than inventing', () => {
  const series = buildForecastSeries({
    startIso: '2026-08-10', days: 3,
    committedByDay: new Map([['2026-08-11', 400]]),
    runRate: { byWeekday: [null, null, null, null, null, null, null], overall: null },
  });
  assert.deepEqual(series.map((d) => d.projected), [0, 0, 0]);
  assert.deepEqual(series.map((d) => d.total), [0, 400, 0], 'committed money still shows');
  assert.equal(series[0].hasRate, false, 'the UI can say "not enough history"');
});

test('an unobserved weekday falls back to the overall average', () => {
  const runRate = { byWeekday: [null, 900, null, null, null, null, null], overall: 500 };
  const [sunday] = buildForecastSeries({ startIso: '2026-08-09', days: 1, runRate }); // Sunday
  assert.equal(sunday.projected, 500, 'the overall prior, not zero');
});

test('expectedInflow never forecasts money already collected', () => {
  // Fully prepaid: nothing left to expect.
  assert.equal(expectedInflow({ kind: 'PICKUP', dateIso: '2026-08-10', expectedTotal: 500, alreadyPaid: 500 }), null);
  assert.equal(expectedInflow({ kind: 'PICKUP', dateIso: '2026-08-10', expectedTotal: 500, alreadyPaid: 800 }), null, 'overpaid is not negative cash flow');
  // Partially prepaid: only the balance.
  assert.deepEqual(
    expectedInflow({ kind: 'PICKUP', dateIso: '2026-08-10', expectedTotal: 500, alreadyPaid: 200 }),
    { iso: '2026-08-10', amount: 300, kind: 'PICKUP' },
  );
  // Junk dates are refused rather than bucketed somewhere wrong.
  assert.equal(expectedInflow({ kind: 'RETURN', dateIso: 'nope', expectedTotal: 100 }), null);
  assert.equal(expectedInflow({ kind: 'RETURN', dateIso: null, expectedTotal: 100 }), null);
});

test('committedByDayFrom sums the same day and drops nulls', () => {
  const map = committedByDayFrom([
    { iso: '2026-08-10', amount: 100.5, kind: 'PICKUP' },
    { iso: '2026-08-10', amount: 49.5, kind: 'RETURN' },
    null,
    { iso: '2026-08-11', amount: 20, kind: 'PICKUP' },
  ]);
  assert.equal(map.get('2026-08-10'), 150);
  assert.equal(map.get('2026-08-11'), 20);
  assert.equal(map.size, 2);
});

test('summarize keeps committed and projected separable in the totals', () => {
  const s = summarize({
    history: [{ iso: '2026-08-01', collected: 100 }, { iso: '2026-08-02', collected: 300 }],
    forecast: [{ committed: 50, projected: 25 }, { committed: 10, projected: 5 }],
  });
  assert.equal(s.historyCollected, 400);
  assert.equal(s.historyDailyAverage, 200);
  assert.equal(s.forecastCommitted, 60);
  assert.equal(s.forecastProjected, 30);
  assert.equal(s.forecastTotal, 90);
  assert.deepEqual(s.bestDay, { iso: '2026-08-02', collected: 300 });
});

test('empty inputs summarize to zeros, never NaN', () => {
  const s = summarize({});
  assert.equal(s.historyCollected, 0);
  assert.equal(s.historyDailyAverage, 0);
  assert.equal(s.forecastTotal, 0);
  assert.equal(s.bestDay, null);
});

// ---------------------------------------------------------------------------
// splitExpectedMoney — the prepaid bug (Hector, 2026-08-07)
// ---------------------------------------------------------------------------

test('THE PREPAID BUG: a franchise import with rate 0 is NOT counter cash', () => {
  // The exact shape from production: FRANCHISE_TL, dailyRate 0.00, zero charge
  // rows, estimatedTotal $140 — the OTA already took that money. Forecasting
  // it put money in the chart that will never reach the counter.
  const out = splitExpectedMoney({ estimatedTotal: 140, dailyRate: 0, charges: [] });
  assert.equal(out.collectible, 0, 'nothing for us to collect');
  assert.equal(out.prepaid, 140, 'and it is visible as collected upstream');
  assert.equal(out.rate, 0);
});

test('an explicitly prepaid booking still owes its fees and taxes at the counter', () => {
  // Rate settled upstream; the counter still collects the license fee and tax.
  const out = splitExpectedMoney({
    estimatedTotal: 236,
    isPrepaid: true,
    charges: [
      { code: 'DAILY', chargeType: 'UNIT', total: 200 },
      { code: 'VLF', chargeType: 'UNIT', total: 12 },
      { code: 'TAX', chargeType: 'TAX', total: 24 },
    ],
  });
  assert.equal(out.rate, 200);
  assert.equal(out.fees, 12);
  assert.equal(out.taxes, 24);
  assert.equal(out.collectible, 36, 'fees + taxes only — the rate was already paid');
  assert.equal(out.prepaid, 200);
});

test('a normal booking commits everything and still shows its shape', () => {
  const out = splitExpectedMoney({
    estimatedTotal: 236, dailyRate: 50,
    charges: [
      { code: 'DAILY', chargeType: 'UNIT', total: 200 },
      { code: 'VLF', chargeType: 'UNIT', total: 12 },
      { code: 'TAX', chargeType: 'TAX', total: 24 },
    ],
  });
  assert.equal(out.collectible, 236);
  assert.equal(out.prepaid, 0);
  assert.deepEqual([out.rate, out.fees, out.taxes], [200, 12, 24], 'rate / fees / taxes are separable');
});

test('a partially paid booking commits only the remainder', () => {
  const out = splitExpectedMoney({
    estimatedTotal: 236, dailyRate: 50, alreadyPaid: 100,
    charges: [
      { code: 'DAILY', chargeType: 'UNIT', total: 200 },
      { code: 'TAX', chargeType: 'TAX', total: 36 },
    ],
  });
  assert.equal(out.collectible, 136);
  assert.equal(out.prepaid, 100);
});

test('voided charge rows do not count', () => {
  const out = splitExpectedMoney({
    estimatedTotal: 100, dailyRate: 50,
    charges: [
      { code: 'DAILY', chargeType: 'UNIT', total: 100 },
      { code: 'EXTRA', chargeType: 'UNIT', total: 999, selected: false },
    ],
  });
  assert.equal(out.rate, 100);
  assert.equal(out.fees, 0, 'a voided row is not money');
});

test('no charge rows yet on a REAL booking estimates the tax shape', () => {
  // A staff booking made before pricing rows exist: the operator still sees
  // rate vs tax instead of one opaque number.
  const out = splitExpectedMoney({ estimatedTotal: 223, dailyRate: 100, taxRatePct: 11.5 });
  assert.equal(out.rate, 200);
  assert.equal(out.taxes, 23);
  assert.equal(out.collectible, 223);
  assert.equal(out.prepaid, 0);
});

test('a worthless or malformed booking contributes nothing', () => {
  for (const bad of [{}, { estimatedTotal: 0 }, { estimatedTotal: -5 }, { estimatedTotal: 'abc' }]) {
    const out = splitExpectedMoney(bad);
    assert.equal(out.collectible, 0);
    assert.equal(out.prepaid, 0);
  }
});

test('summarize carries the component breakdown through', () => {
  const s = summarize({
    history: [], forecast: [{ committed: 100, projected: 0 }],
    components: { rate: 60, fees: 15, taxes: 25, prepaid: 400, prepaidCount: 3, balances: 0 },
  });
  assert.equal(s.components.rate, 60);
  assert.equal(s.components.prepaid, 400, 'prepaid sits BESIDE committed, never inside it');
  assert.equal(s.forecastCommitted, 100);
});
