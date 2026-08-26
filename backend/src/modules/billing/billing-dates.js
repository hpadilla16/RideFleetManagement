/**
 * Calendar dates for billing — the pure half, no IO.
 *
 * WHY BILLING DATES ARE STRINGS AND NOT DateTime
 * ------------------------------------------------------------------
 * ARB bills on a CALENDAR DAY in the merchant's own time, not at an instant.
 * Puerto Rico is UTC-4, so a DateTime rendered without an explicit UTC time
 * zone shows the day BEFORE the one Authorize.Net will actually charge — the
 * customer authorises "primer cobro el 29 de septiembre" and the card moves on
 * the 30th. That is a support call and, eventually, a chargeback.
 *
 * Storing the calendar date as VARCHAR(10) 'YYYY-MM-DD' makes the value we
 * send to ARB, the value we store, and the value we render byte-identical, and
 * kills the whole bug class at the schema instead of relying on every future
 * call site to remember one formatter option.
 *
 * Every function here builds Dates with Date.UTC and formats with
 * timeZone: 'UTC'. Never reach for a local `new Date(y, m, d)` in this module:
 * that is how you bill somebody for 31 days in a 30-day month.
 */

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDate(value) {
  if (!CALENDAR_DATE_RE.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Round-trip through UTC to reject 2026-02-30 and friends.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function assertCalendarDate(value, label = 'date') {
  if (!isCalendarDate(value)) {
    throw new Error(`${label} must be a calendar date in YYYY-MM-DD form (got ${String(value)})`);
  }
  return String(value);
}

/** Today as a calendar date. `now` is injectable so tests are not clock-dependent. */
export function todayCalendarDate(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function addCalendarDays(date, days) {
  const [y, m, d] = assertCalendarDate(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

export function addCalendarMonths(date, months) {
  const [y, m, d] = assertCalendarDate(date).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + Number(months || 0), 1));
  // Clamp the day so 31 January + 1 month is 28/29 February, not 2 or 3 March.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Advance one billing period. ARB's own vocabulary: 'months' | 'days'. */
export function addInterval(date, intervalUnit, intervalLength) {
  const length = Number(intervalLength || 0);
  if (intervalUnit === 'days') return addCalendarDays(date, length);
  if (intervalUnit === 'months') return addCalendarMonths(date, length);
  throw new Error(`Unsupported intervalUnit "${intervalUnit}" (ARB accepts "months" or "days").`);
}

/**
 * Render a calendar date in the enrollment pages' language.
 *
 * `timeZone: 'UTC'` is LOAD-BEARING and matches how the date was built above.
 * WITHOUT it, es-PR (UTC-4) renders midnight UTC as the PREVIOUS day, and the
 * customer is shown — and consents to — a charge dated one day before the one
 * that actually runs. Do not "simplify" this option away.
 */
export function formatCalendarDateEs(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return String(date);
  return new Intl.DateTimeFormat('es-PR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

const CADENCE_ES = {
  months: { 1: 'mensual', 3: 'trimestral', 6: 'semestral', 12: 'anual' },
  days: {},
};

export function cadenceLabelEs(intervalUnit, intervalLength) {
  return (
    CADENCE_ES[intervalUnit]?.[Number(intervalLength)]
    || `cada ${intervalLength} ${intervalUnit === 'months' ? 'meses' : 'días'}`
  );
}

/** "$199.00" — two decimals, always, in the same shape the ledger stores. */
export function formatMoney(amount) {
  return Number(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
