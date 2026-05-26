/**
 * Shared date utilities used across booking-engine, car-sharing, rates, and planner modules.
 */

export const DEFAULT_TENANT_TIMEZONE = 'America/Puerto_Rico';

// Detects an ISO datetime string that already carries timezone information
// (trailing "Z", "+HH:MM", "-HHMM", etc). When this matches we accept the
// value as-is; otherwise we treat it as a wall-clock time in the tenant TZ.
const ISO_DATETIME_WITH_TZ = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

/**
 * Parse any value to a Date, returning null for invalid input.
 */
export function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Parse a datetime input as wall-clock time in the given IANA tenant
 * timezone, returning the equivalent UTC Date.
 *
 * Behavior:
 *   - Date instances → returned as-is
 *   - Strings with an explicit Z or numeric TZ offset → parsed normally
 *   - "Naive" strings like "2026-05-26T11:19" → interpreted in tenantTz
 *
 * Rationale: HTML `<input type="datetime-local">` returns naive strings
 * (no Z), so the obvious `new Date(input)` on the backend (which runs
 * with TZ=UTC inside Docker) silently treats "11:19" as UTC and stores
 * a value 4 hours ahead of the intended Puerto-Rico wall-clock time.
 * Routing the input through this helper makes the naive string mean
 * what the agent typed.
 *
 * Strings with already-explicit TZ keep working unchanged — that's the
 * shape sent by API clients, integrations (TL imports), and any FE that
 * was already calling `.toISOString()` before sending.
 */
export function parseDateTimeInTz(value, tenantTz = DEFAULT_TENANT_TIMEZONE) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;

  const s = String(value).trim();
  if (!s) return null;

  // Already carries TZ info — let the JS parser handle it.
  if (ISO_DATETIME_WITH_TZ.test(s)) {
    const direct = new Date(s);
    return Number.isNaN(direct.getTime()) ? null : direct;
  }

  // Try a strict naive match.
  const m = s.match(NAIVE_ISO_DATETIME);
  if (!m) {
    // Unrecognized shape — fall through to JS Date parser to stay
    // forgiving (matches the pre-existing normalizeDate behavior).
    const fallback = new Date(s);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, yStr, monStr, dStr, hStr, miStr, seStr, msStr] = m;
  const Y = Number(yStr);
  const M = Number(monStr);
  const D = Number(dStr);
  const h = hStr ? Number(hStr) : 0;
  const mi = miStr ? Number(miStr) : 0;
  const se = seStr ? Number(seStr) : 0;
  const ms = msStr ? Number(String(msStr).padEnd(3, '0').slice(0, 3)) : 0;

  // Build a Date treating the requested wall-clock components as UTC.
  const naiveUtc = new Date(Date.UTC(Y, M - 1, D, h, mi, se, ms));
  if (Number.isNaN(naiveUtc.getTime())) return null;

  // Helper: render a Date in tenantTz and read its wall-clock components.
  // Intl truncates to second resolution; we strip milliseconds from the
  // probe and re-apply them at the end so 11:19:30.500 ASTroundtrips clean.
  const renderInTz = (utcDate) => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: tenantTz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).formatToParts(utcDate).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
      }, {});
    } catch {
      return null;
    }
  };

  const partsToUtcMs = (parts) => {
    if (!parts) return NaN;
    const hh = parts.hour === '24' ? '0' : parts.hour;
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(hh),
      Number(parts.minute),
      Number(parts.second)
    );
  };

  // Initial guess: pretend the wall-clock components ARE UTC, read the offset
  // of tenantTz at that moment, then shift by that offset. This is correct
  // outside of DST transitions.
  const probeUtc = new Date(Date.UTC(Y, M - 1, D, h, mi, se, 0));
  const firstParts = renderInTz(probeUtc);
  if (!firstParts) {
    // Unknown IANA TZ — bail to naive UTC parse so we don't silently
    // mask a misconfiguration with a "close enough" answer.
    return naiveUtc;
  }
  const initialOffsetMs = probeUtc.getTime() - partsToUtcMs(firstParts);
  let guess = new Date(naiveUtc.getTime() + initialOffsetMs);

  // Iterative refinement for DST boundaries. Around spring-forward / fall-
  // back the offset at the naive instant differs from the offset that
  // actually applies at the requested local time, so the initial guess can
  // land an hour off. Render the guess back, compare components, and shift
  // by the delta. Two iterations cover every real-world case (the second
  // pass settles tz-day rollovers introduced by the first shift).
  const target = Date.UTC(Y, M - 1, D, h, mi, se, 0);
  for (let iter = 0; iter < 2; iter++) {
    const guessParts = renderInTz(guess);
    if (!guessParts) break;
    const renderedMs = partsToUtcMs(guessParts);
    const diff = target - renderedMs;
    if (diff === 0) break;
    // Cap the adjustment at ±25 hours to defend against pathological inputs
    // (extremely fractional or non-existent month/year combos).
    const capped = Math.max(-25 * 3600_000, Math.min(25 * 3600_000, diff));
    guess = new Date(guess.getTime() + capped);
  }

  // For non-existent spring-forward times (e.g. NY 2:30 AM on the DST jump
  // day), the iteration converges to a guess whose rendered hour is one
  // ahead — that's the "skip the gap forward" convention used by most
  // systems, and matches what JS does internally for new Date('YYYY-MM-DDTHH:mm')
  // in a DST-observing TZ environment. We accept that as correct.
  return guess;
}

/**
 * Return the start of a UTC day (midnight) for the given date.
 */
export function startOfUtcDay(dt) {
  const d = normalizeDate(dt);
  if (!d) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Add N whole UTC days to a date.
 */
export function addUtcDays(dt, days) {
  const d = normalizeDate(dt);
  if (!d) return null;
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Return the number of billable days for a trip, always rounding up partial days.
 */
export function ceilTripDays(startAt, endAt) {
  const s = normalizeDate(startAt);
  const e = normalizeDate(endAt);
  if (!s || !e || e <= s) return 0;
  return Math.ceil((e.getTime() - s.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Parse a hours-window value, returning fallback for invalid input.
 */
export function normalizeWindowHours(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * Return true if [startA, endA) overlaps with [startB, endB).
 */
export function overlapsWindow(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

// ---------------------------------------------------------------------------
// Tenant-TZ aware helpers (2026-05-26)
//
// Every "by day" / "by month" report bucketed reservations against the
// server's local timezone (= UTC inside the Docker container), which silently
// rolled late-evening AST events into the next UTC calendar day. Each report
// used to ship its own setHours(0,0,0,0) / toISOString().slice(0,10) /
// new Date(y, m, 1) helpers. Consolidating here so every report shares the
// same definition and we fix the bug in one place.
//
// PR has no DST. For tenants in DST zones, addDaysInTz uses a flat 24h step
// which can land on a sibling day on the spring-forward / fall-back day.
// Acceptable approximation until we onboard a DST tenant.
// ---------------------------------------------------------------------------

const _MS_PER_DAY_DUTL = 24 * 60 * 60 * 1000;

/**
 * Lower-level helper: pull the wall-clock year/month/day for `date` rendered
 * in `tz` as two-digit strings. Used by every "in tz" function below.
 */
function tzDateParts(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
}

/**
 * Midnight of `value` interpreted in `tz`, returned as a UTC Date instant.
 *
 * Accepts:
 *   - "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM[:SS]" strings (any time component is
 *     stripped — we always return midnight of the day in tz)
 *   - Date instances (the tz-day they fall on)
 *   - null / undefined → null
 */
export function startOfDayInTz(value, tz = DEFAULT_TENANT_TIMEZONE) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const dayOnly = value.length >= 10 ? value.slice(0, 10) : value;
    return parseDateTimeInTz(dayOnly, tz);
  }
  if (value instanceof Date) {
    const parts = tzDateParts(value, tz);
    return parseDateTimeInTz(`${parts.year}-${parts.month}-${parts.day}`, tz);
  }
  return null;
}

/**
 * First day of the month containing `date`, anchored at midnight in tz.
 */
export function startOfMonthInTz(date, tz = DEFAULT_TENANT_TIMEZONE) {
  const parts = tzDateParts(date, tz);
  return parseDateTimeInTz(`${parts.year}-${parts.month}-01`, tz);
}

/**
 * Add `n` whole days to `date`. 24h step (no DST correction).
 */
export function addDaysInTz(date, n) {
  return new Date(date.getTime() + n * _MS_PER_DAY_DUTL);
}

/**
 * Add `n` months. Result is the 1st of the target month at midnight in tz.
 */
export function addMonthsInTz(date, n, tz = DEFAULT_TENANT_TIMEZONE) {
  const parts = tzDateParts(date, tz);
  let year = Number(parts.year);
  let month = Number(parts.month) - 1 + n; // 0-indexed for math
  while (month < 0)  { month += 12; year -= 1; }
  while (month > 11) { month -= 12; year += 1; }
  const mStr = String(month + 1).padStart(2, '0');
  return parseDateTimeInTz(`${year}-${mStr}-01`, tz);
}

/**
 * "YYYY-MM-DD" of `date` evaluated in tz. Use this anywhere reports were
 * calling `d.toISOString().slice(0, 10)` and getting the UTC day instead of
 * the tenant-local day.
 */
export function isoDayInTz(date, tz = DEFAULT_TENANT_TIMEZONE) {
  const parts = tzDateParts(date, tz);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Short human label like "Wed May 26" of `date` in tz. Pass
 * `{ includeWeekday: false }` to drop the weekday prefix → "May 26".
 */
export function dayLabelInTz(date, tz = DEFAULT_TENANT_TIMEZONE, { includeWeekday = true } = {}) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    ...(includeWeekday ? { weekday: 'short' } : {}),
    month: 'short', day: 'numeric'
  }).format(date).replace(',', '');
}

/**
 * Short month label like "May 26" (3-letter month + 2-digit year) of `date`
 * evaluated in tz. Used by monthly aggregation reports.
 */
export function monthLabelInTz(date, tz = DEFAULT_TENANT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'short'
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.month} ${String(parts.year).slice(2)}`;
}
