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
 * Booking channels whose RATE is collected by whoever sold the booking, not
 * at our counter.
 *
 * Hector, 2026-08-07: "todos los que son de TL International que terminan en
 * BA son Pre Paid". Measured: 797 of 798 FRANCHISE_TL reservations end in BA,
 * so the suffix discriminates nothing — the CHANNEL is the rule. And the
 * channel is the only reliable signal: 10 of those BA rows carry a real
 * dailyRate (up to $102.24), so the "rate is zero" heuristic alone silently
 * committed them.
 *
 * ECONOMY and NU are here for the same reason, found the same way: on
 * 2026-08-07 Corpusa had 647 upcoming FRANCHISE_ECONOMY and 186
 * FRANCHISE_NU pickups and NOT ONE carried a rate, so every one was landing
 * in the rate-shape fallback below. Right answer, reached by accident — the
 * first one that arrives with a rate would have been committed. Naming them
 * makes it a decision.
 *
 * FRANCHISE_MEX is deliberately NOT here — MEX sells both prepaid and
 * pay-at-destination, decided per rate code (mex.constants classifyMexRateCode),
 * and the counter really does collect on POA bookings. Its 3 upcoming IRC
 * pickups all carry a rate, which is exactly the shape that should commit.
 */
export const PREPAID_BOOKING_CHANNELS = Object.freeze(
  String(process.env.CASHFLOW_PREPAID_CHANNELS || 'FRANCHISE_TL,FRANCHISE_ECONOMY,FRANCHISE_NU')
    .split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)
);

/** Is this booking's rate settled by the seller rather than by us? */
export function isPrepaidBooking({ isPrepaid = null, bookingChannel = null, dailyRate = null } = {}) {
  if (isPrepaid === true) return true;
  if (isPrepaid === false) return false;
  const channel = String(bookingChannel || '').trim().toUpperCase();
  if (channel && PREPAID_BOOKING_CHANNELS.includes(channel)) return true;
  // Fallback for channels we have not classified: a booking worth money with
  // no rate of its own was priced somewhere else. NULL counts — the franchise
  // importers leave dailyRate null, not 0, and an `!= null` guard here would
  // quietly commit every one of them.
  return Number(dailyRate || 0) <= 0;
}

/**
 * Split a reservation's expected money into what the COUNTER will actually
 * collect and what was already collected upstream.
 *
 * THE BUG THIS EXISTS FOR (Hector, 2026-08-07): franchise imports
 * (FRANCHISE_TL and friends) arrive with dailyRate 0.00, ZERO charge rows and
 * an estimatedTotal that is the FRANCHISE's number — money the OTA already
 * took. Treating estimatedTotal as "cash coming to us" put $140-$186 a head
 * into a forecast that will never see a cent of it. A rate of zero on a
 * booking worth something is the signature of "somebody else got paid".
 *
 * Charge rows are the truth when they exist — they ARE the contract. Without
 * them we fall back to the reservation's own header fields, and the rate-zero
 * shape decides where the money goes.
 *
 * @param {object} r
 * @param {number} r.estimatedTotal
 * @param {number} r.dailyRate
 * @param {number} r.alreadyPaid       payments RFM itself captured
 * @param {boolean|null} r.isPrepaid   explicit flag when the source sets it
 * @param {Array<{code, chargeType, total, taxable}>} r.charges
 * @param {number} r.taxRatePct        pickup location's tax rate, for the estimate
 * @param {string|null} r.bookingChannel  decides prepaid when isPrepaid is unset
 * @returns {{rate, fees, taxes, collectible, prepaid}}
 */
export function splitExpectedMoney({
  estimatedTotal = 0, dailyRate = 0, alreadyPaid = 0, isPrepaid = null,
  bookingChannel = null, charges = null, taxRatePct = 0,
} = {}) {
  const prepaidBooking = isPrepaidBooking({ isPrepaid, bookingChannel, dailyRate });
  const total = Number(estimatedTotal || 0);
  const paid = Number(alreadyPaid || 0);
  const zero = { rate: 0, fees: 0, taxes: 0, collectible: 0, prepaid: 0 };
  if (!Number.isFinite(total) || total <= 0) return zero;

  const rows = Array.isArray(charges) ? charges.filter((c) => c && c.selected !== false) : null;

  if (rows && rows.length) {
    let rate = 0; let taxes = 0; let fees = 0;
    for (const c of rows) {
      const amount = Number(c.total || 0);
      const type = String(c.chargeType || '').toUpperCase();
      const code = String(c.code || '').toUpperCase();
      if (type === 'TAX' || code === 'TAX') taxes += amount;
      else if (code === 'DAILY' || code === 'BASE_RATE' || type === 'DAILY') rate += amount;
      else fees += amount;
    }
    const gross = round2(rate + fees + taxes);
    // A prepaid booking has had its RATE settled upstream; the counter still
    // collects fees and taxes.
    const prepaidRate = prepaidBooking ? round2(rate) : 0;
    const collectible = round2(Math.max(0, gross - prepaidRate - paid));
    return {
      rate: round2(rate), fees: round2(fees), taxes: round2(taxes),
      collectible, prepaid: round2(prepaidRate + Math.min(paid, gross - prepaidRate)),
    };
  }

  // No charge rows yet: with nothing itemised, a prepaid booking has nothing
  // for us to collect at all.
  if (prepaidBooking) {
    return { rate: 0, fees: 0, taxes: 0, collectible: 0, prepaid: round2(total) };
  }

  // A real staff/website booking without rows yet: estimate the shape so the
  // operator sees rate vs tax vs fees rather than one opaque number.
  const pct = Number(taxRatePct || 0);
  const rate = round2(total / (1 + pct / 100));
  const taxes = round2(total - rate);
  const collectible = round2(Math.max(0, total - paid));
  return { rate, fees: 0, taxes, collectible, prepaid: round2(Math.min(paid, total)) };
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
export function summarize({ history = [], forecast = [], components = null } = {}) {
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
    // What the committed money is MADE OF, and what sits beside it as already
    // collected upstream (Hector 2026-08-07 — "poner estimated taxes y
    // estimated fees aparte para que puedan ver whole picture of cash flow").
    ...(components ? { components } : {}),
  };
}
