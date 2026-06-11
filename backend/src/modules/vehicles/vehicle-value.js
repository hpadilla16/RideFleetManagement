/**
 * Vehicle value & fleet-rotation helpers (2026-06-10, Vehicle Profile pack).
 *
 * PURE — no prisma, no env, no side effects (unit-tested without mocks).
 * Informational only: nothing here feeds billing or money paths.
 *
 * Depreciation = DECLINING BALANCE (Hector's pick, 2026-06-10):
 *   currentValue = acquisitionCost × (1 − annualPct/100) ^ (monthsInFleet / 12)
 *
 * Rotation rule is per-tenant (AppSetting `fleetRotationConfig`, rule TIME|MILEAGE):
 *   TIME    → ready when monthsInFleet >= targetFleetMonths
 *   MILEAGE → ready when mileage >= targetFleetMiles
 *   "approaching" = within 60 days (TIME) or within 2,000 miles (MILEAGE).
 */

const APPROACHING_DAYS = 60;
const APPROACHING_MILES = 2000;

export const ROTATION_RULES = Object.freeze(['TIME', 'MILEAGE']);

function toNumber(value) {
  if (value == null || value === '') return null; // Number(null) === 0 — not what we want
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Whole+fractional months between two dates (>= 0). */
export function monthsBetween(from, to) {
  const a = from instanceof Date ? from : new Date(from);
  const b = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const ms = b.getTime() - a.getTime();
  if (ms <= 0) return 0;
  return ms / (1000 * 60 * 60 * 24 * 30.4375); // mean month length
}

/**
 * Declining-balance value. Returns null when cost/pct/date are incomplete.
 * @returns {null | { currentValue, depreciatedPct, monthsInFleet }}
 */
export function computeVehicleValue({ acquisitionCost, acquisitionDate, depreciationAnnualPct, now = new Date() }) {
  const cost = toNumber(acquisitionCost);
  const pct = toNumber(depreciationAnnualPct);
  if (cost == null || cost <= 0 || pct == null || pct < 0 || pct >= 100 || !acquisitionDate) return null;
  const months = monthsBetween(acquisitionDate, now);
  if (months == null) return null;
  const currentValue = Math.round(cost * Math.pow(1 - pct / 100, months / 12) * 100) / 100;
  const depreciatedPct = Math.round((1 - currentValue / cost) * 1000) / 10;
  return {
    currentValue,
    depreciatedPct,
    monthsInFleet: Math.round(months * 10) / 10
  };
}

/**
 * Rotation status under the tenant rule.
 * @returns {'ready'|'approaching'|'ok'|null} null = not enough data to judge.
 */
export function rotationStatus({ rule = 'TIME', acquisitionDate, targetFleetMonths, mileage, targetFleetMiles, now = new Date() }) {
  const r = String(rule || 'TIME').toUpperCase();
  if (r === 'MILEAGE') {
    const miles = toNumber(mileage);
    const target = toNumber(targetFleetMiles);
    if (miles == null || target == null || target <= 0) return null;
    if (miles >= target) return 'ready';
    if (target - miles <= APPROACHING_MILES) return 'approaching';
    return 'ok';
  }
  // TIME (default)
  const target = toNumber(targetFleetMonths);
  if (!acquisitionDate || target == null || target <= 0) return null;
  const months = monthsBetween(acquisitionDate, now);
  if (months == null) return null;
  if (months >= target) return 'ready';
  const daysLeft = (target - months) * 30.4375;
  if (daysLeft <= APPROACHING_DAYS) return 'approaching';
  return 'ok';
}

/** Registration status against `now`. */
export function registrationStatus(registrationExpiresAt, now = new Date()) {
  if (!registrationExpiresAt) return null;
  const exp = registrationExpiresAt instanceof Date ? registrationExpiresAt : new Date(registrationExpiresAt);
  if (Number.isNaN(exp.getTime())) return null;
  const days = Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  if (days < 0) return { status: 'expired', daysLeft: days };
  if (days <= 30) return { status: 'expiring', daysLeft: days };
  return { status: 'ok', daysLeft: days };
}
