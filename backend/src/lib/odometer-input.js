/**
 * Odometer input sanitizer (2026-09-02, Sentry 371e0617).
 *
 * An IRC agent typed 3,334,933,457 into an inspection odometer and the raw
 * `Number(payload.odometer)` rode it straight into Postgres, where INT4 tops
 * out at 2,147,483,647 — a ConnectorError 500 with no message the agent could
 * act on. The counter-UX mileage guard deliberately WARNS instead of blocking
 * (corrections are real), which makes the server the only place that can
 * refuse the physically impossible.
 *
 * ODOMETER_MAX is 9,999,999: no road vehicle has ever recorded eight digits
 * of miles, and it leaves two orders of magnitude of headroom under INT4 so
 * this bound never has to know about column widths.
 *
 * Returns the parsed integer, or null when the field was absent/blank
 * (callers treat null as "not provided" — same contract they already had).
 * Throws on NaN, negatives, and values above the cap; the message contains
 * "odometer" so the routes' error mappers turn it into a 400.
 */

export const ODOMETER_MAX = 9_999_999;

export function parseOdometerInput(value, { field = 'odometer' } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > ODOMETER_MAX) {
    throw new Error(
      `${field} must be a whole number between 0 and ${ODOMETER_MAX.toLocaleString('en-US')} — got "${String(value).slice(0, 24)}"`
    );
  }
  return n;
}
