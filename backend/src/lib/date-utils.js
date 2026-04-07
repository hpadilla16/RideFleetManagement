/**
 * Shared date utilities used across booking-engine, car-sharing, rates, and planner modules.
 */

/**
 * Parse any value to a Date, returning null for invalid input.
 */
export function normalizeDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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
