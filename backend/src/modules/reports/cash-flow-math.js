/**
 * Cash-flow forecasting math — PURE (no prisma, no IO, no clock) so CI's
 * DB-free step guards it. 2026-08-07, Hector: "historial de collected today
 * y una grafica interactiva que muestra cash flow history and forecasting".
 *
 * THE MODEL, and why it is shaped this way.
 *
 * A forecast that mixes "money we know is coming" with "money we guess is
 * coming" is worse than no forecast: the operator cannot tell which half to
 * bet payroll on. So every future day carries TWO numbers that never blend:
 *
 *   COMMITTED — dated money from rows that already exist. A confirmed
 *     reservation's unpaid balance lands on its PICKUP day (that is when the
 *     counter collects); an open contract's outstanding balance lands on its
 *     RETURN day (that is when it settles). This is a floor, not a guess.
 *
 *   PROJECTED — the bookings nobody has made yet. Estimated from the trailing
 *     run-rate for THAT WEEKDAY (car rental is violently weekly: a Saturday
 *     is not a Tuesday), and only the part the committed rows do not already
 *     explain: projected = max(0, weekdayRunRate − committed).
 *
 * The subtraction is the whole point. Without it, a Tuesday with $1,200
 * already booked and a $2,000 Tuesday average would forecast $3,200 — double
 * counting the same customers. With it: $1,200 committed + $800 projected,
 * and the $2,000 total stays honest as the horizon fills in.
 *
 * Projection confidence DECAYS with distance: 14 days out, a weekday average
 * still describes the world; 60 days out it is barely a prior. Callers get
 * the decay factor so the chart can fade the band instead of pretending.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** ISO day (UTC-safe) N days after an ISO day. */
export function addIsoDays(iso, n) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00.000Z`);
  return new Date(d.getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** 0=Sunday … 6=Saturday, from an ISO day. */
export function weekdayOf(iso) {
  return new Date(`${String(iso).slice(0, 10)}T00:00:00.000Z`).getUTCDay();
}

/**
 * Trailing per-weekday averages from history.
 *
 * Zero-collection days COUNT (a dead Monday is information about Mondays),
 * but a weekday with no observations at all yields null rather than 0 — "we
 * have never seen a Sunday" must not forecast "Sundays earn nothing".
 *
 * @param {Array<{iso: string, collected: number}>} historyDays
 * @param {{weeks?: number, asOf?: string}} opts  weeks = trailing window
 * @returns {{byWeekday: Array<number|null>, overall: number|null, sampleDays: number}}
 */
export function weekdayRunRate(historyDays = [], { weeks = 8, asOf = null } = {}) {
  const cutoff = asOf ? addIsoDays(asOf, -Math.abs(weeks) * 7) : null;
  const sums = Array.from({ length: 7 }, () => ({ total: 0, n: 0 }));
  let overallTotal = 0;
  let overallN = 0;

  for (const d of historyDays) {
    if (!d?.iso) continue;
    if (cutoff && String(d.iso) < cutoff) continue;
    const amount = Number(d.collected || 0);
    if (!Number.isFinite(amount)) continue;
    const w = weekdayOf(d.iso);
    sums[w].total += amount;
    sums[w].n += 1;
    overallTotal += amount;
    overallN += 1;
  }

  return {
    byWeekday: sums.map((s) => (s.n ? round2(s.total / s.n) : null)),
    overall: overallN ? round2(overallTotal / overallN) : null,
    sampleDays: overallN,
  };
}

/**
 * How much to trust a weekday average this far out. 1.0 for the first week,
 * decaying to a floor beyond the booking horizon. Pure presentation of
 * uncertainty — it never changes the COMMITTED number.
 */
export function confidenceFor(daysOut, { fullTrustDays = 7, floor = 0.35, horizon = 60 } = {}) {
  const n = Math.max(0, Number(daysOut) || 0);
  if (n <= fullTrustDays) return 1;
  if (n >= horizon) return floor;
  const span = horizon - fullTrustDays;
  return round2(1 - ((1 - floor) * (n - fullTrustDays)) / span);
}

/**
 * Build the forecast series.
 *
 * @param {object} p
 * @param {string} p.startIso        first forecast day (usually tomorrow)
 * @param {number} p.days            horizon length
 * @param {Map<string, number>|object} p.committedByDay  iso → committed money
 * @param {{byWeekday: Array<number|null>, overall: number|null}} p.runRate
 * @returns {Array<{iso, weekday, committed, projected, total, confidence}>}
 */
export function buildForecastSeries({ startIso, days = 30, committedByDay = new Map(), runRate = null } = {}) {
  const get = (iso) => {
    if (committedByDay instanceof Map) return Number(committedByDay.get(iso) || 0);
    return Number((committedByDay || {})[iso] || 0);
  };
  const out = [];
  for (let i = 0; i < Math.max(0, Number(days) || 0); i += 1) {
    const iso = addIsoDays(startIso, i);
    const weekday = weekdayOf(iso);
    const committed = round2(get(iso));
    // A weekday we have never observed falls back to the overall average;
    // with no history at all there is nothing to project and we say so with
    // 0 rather than inventing a number.
    const rate = runRate?.byWeekday?.[weekday] ?? runRate?.overall ?? null;
    const confidence = confidenceFor(i + 1);
    // The subtraction that keeps the total honest — see the header.
    const projected = rate == null ? 0 : round2(Math.max(0, rate - committed) * confidence);
    out.push({
      iso,
      weekday,
      committed,
      projected,
      total: round2(committed + projected),
      confidence,
      hasRate: rate != null,
    });
  }
  return out;
}

/**
 * Where a piece of expected money lands, and how much of it is still owed.
 * Pure so the "do not double-count what was already paid" rule is testable.
 *
 * @returns {{iso: string, amount: number, kind: 'PICKUP'|'RETURN'} | null}
 */
export function expectedInflow({ kind, dateIso, expectedTotal, alreadyPaid = 0 }) {
  const total = Number(expectedTotal || 0);
  const paid = Number(alreadyPaid || 0);
  const owed = round2(total - paid);
  // Fully prepaid rows contribute NOTHING to the forecast — that money was
  // already counted the day it was collected, and counting it again is the
  // classic way a cash-flow chart lies.
  if (!Number.isFinite(owed) || owed <= 0) return null;
  const iso = String(dateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return { iso, amount: owed, kind };
}

/** Sum expected inflows into an iso → amount map, ignoring anything null. */
export function committedByDayFrom(inflows = []) {
  const map = new Map();
  for (const row of inflows) {
    if (!row) continue;
    map.set(row.iso, round2((map.get(row.iso) || 0) + Number(row.amount || 0)));
  }
  return map;
}

/** Totals for the header tiles. */
export function summarize({ history = [], forecast = [] } = {}) {
  const collected = round2(history.reduce((s, d) => s + Number(d.collected || 0), 0));
  const committed = round2(forecast.reduce((s, d) => s + Number(d.committed || 0), 0));
  const projected = round2(forecast.reduce((s, d) => s + Number(d.projected || 0), 0));
  const bestDay = history.reduce((best, d) => (!best || Number(d.collected || 0) > Number(best.collected || 0) ? d : best), null);
  return {
    historyCollected: collected,
    historyDailyAverage: history.length ? round2(collected / history.length) : 0,
    forecastCommitted: committed,
    forecastProjected: projected,
    forecastTotal: round2(committed + projected),
    bestDay: bestDay ? { iso: bestDay.iso, collected: round2(Number(bestDay.collected || 0)) } : null,
  };
}
