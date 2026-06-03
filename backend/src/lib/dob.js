/**
 * Date-of-birth sanitation.
 *
 * `new Date(value)` happily accepts absurd years — `new Date('0959-04-01')`
 * yields year 959, `new Date('2800-04-01')` yields year 2800 — and those flowed
 * straight into Customer/RentalAgreement.dateOfBirth, then into the checkout age
 * gate which computed ages like 1067 and blocked checkout with a baffling
 * "Driver age 1067 exceeds maximum age" error (incident: TL-ZE40789836BA,
 * 2026-06-02).
 *
 * normalizeDob() returns a Date ONLY when the value is a plausible birth date,
 * otherwise null — so a garbage value is stored as "no DOB on file" (the agent
 * re-enters it) instead of an impossible date that breaks downstream math.
 *
 * It intentionally does NOT enforce the rental minimum age (e.g. 21) — that's a
 * per-location business rule handled at the checkout gate. This only rejects the
 * physically impossible: future dates, years before 1900, or ages over 120.
 */

export const DOB_MIN_YEAR = 1900;
export const DOB_MAX_AGE_YEARS = 120;

/**
 * @param {string|Date|null|undefined} value
 * @returns {Date|null} a valid, plausible birth date, or null
 */
export function normalizeDob(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  const now = new Date();
  // Future birth dates are impossible (catches 2800-04-01).
  if (d.getTime() > now.getTime()) return null;

  const year = d.getUTCFullYear();
  if (year < DOB_MIN_YEAR) return null; // catches 0959-04-01

  const approxAge = now.getUTCFullYear() - year;
  if (approxAge > DOB_MAX_AGE_YEARS) return null;

  return d;
}

/**
 * True when a computed age is physically impossible (negative or > 120) —
 * i.e. the DOB on file is garbage, not just out of the rental age range.
 * @param {number|null} age
 */
export function isImplausibleAge(age) {
  return age !== null && age !== undefined && (age < 0 || age > DOB_MAX_AGE_YEARS);
}
