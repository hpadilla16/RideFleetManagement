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

  // Step 1: build a Date treating those components as UTC.
  const naiveUtc = new Date(Date.UTC(Y, M - 1, D, h, mi, se, ms));
  if (Number.isNaN(naiveUtc.getTime())) return null;

  // Step 2: ask Intl what those same wall-clock components would look like
  //         when rendered in tenantTz. The delta naiveUtc - tzRendered is
  //         exactly the offset of tenantTz from UTC at that wall-clock moment.
  //         Intl.DateTimeFormat truncates to second resolution, so we strip
  //         milliseconds off the probe value before formatting and re-apply
  //         them when constructing the final result.
  const probeUtc = new Date(Date.UTC(Y, M - 1, D, h, mi, se, 0));
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tenantTz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(probeUtc).reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  } catch {
    // Unknown IANA TZ identifier — bail to naive UTC parse so we don't
    // hide the misconfiguration behind a worse silent failure.
    return naiveUtc;
  }

  // Some locales render midnight as hour="24"; coerce to "0" for arithmetic.
  const tzHour = parts.hour === '24' ? '0' : parts.hour;
  const tzRendered = new Date(Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(tzHour),
    Number(parts.minute),
    Number(parts.second)
  ));

  const offsetMs = probeUtc.getTime() - tzRendered.getTime();
  return new Date(naiveUtc.getTime() + offsetMs);
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
