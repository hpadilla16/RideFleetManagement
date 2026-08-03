/**
 * Turn-Ready scoring rules — per-tenant configuration (2026-08-03).
 *
 * WHY THIS EXISTS: the Turn-Ready score used to be a fixed formula compiled
 * into `buildTurnReadyScore`. Hector's requirement for dashboard v2 is that a
 * tenant configures how their own score is calculated — a wash matters more to
 * an airport rooftop than to a dealership loaner desk, and nobody outside the
 * operation can pick those numbers for them.
 *
 * TWO INVARIANTS, both enforced by tests:
 *
 *   1. DEFAULTS REPRODUCE THE OLD FORMULA EXACTLY. Every weight below is the
 *      literal constant the previous implementation used. Shipping this must
 *      not move a single live score — the planner assigns vehicles off this
 *      number, so a silent shift would silently change dispatch.
 *
 *   2. THE BREAKDOWN SUMS TO THE SCORE. Each rule contributes one labelled,
 *      signed line. `sum(breakdown.delta) === rawScore`, and when the clamp
 *      fires it becomes its own visible line. The old code pushed prose into
 *      `reasons` with no point value attached and then did `.slice(0, 4)` —
 *      so a vehicle with six deductions displayed four and the visible lines
 *      did not add up. For a screen whose whole claim is "every point traces
 *      to an event", that silent truncation was the bug that mattered.
 *
 * The two NEW factors (documents, maintenance-due) ship DISABLED. They are
 * real and wired to real columns — Vehicle.registrationExpiresAt and
 * ServiceSchedule.nextDueMiles/nextDueAt — but a tenant opts in, because
 * turning them on lowers scores for every unit that already has an expiring
 * registration or an approaching service.
 */

export const TURN_READY_STATUS = Object.freeze({
  READY: 'READY',
  WATCH: 'WATCH',
  ATTENTION: 'ATTENTION',
  BLOCKED: 'BLOCKED',
});

/**
 * Every number here is the constant the pre-2026-08-03 formula used. Changing
 * a default changes live scores for every tenant that has not customized —
 * don't, without saying so out loud.
 */
export const DEFAULT_TURN_READY_RULES = Object.freeze({
  // Active availability blocks. Mutually exclusive — a vehicle is in at most
  // one. The three that push a BLOCKED status are flagged in BLOCKING_KEYS.
  blockWashHold: 35,
  blockMaintenanceHold: 75,
  blockOutOfService: 85,
  blockMigrationHold: 70,

  // Inspection intelligence.
  inspectionMissing: 25,
  inspectionAttention: 28,
  inspectionMissingPhotoEach: 3,
  inspectionMissingPhotoCap: 18,
  inspectionConditionFlagEach: 6,
  inspectionConditionFlagCap: 18,
  inspectionDamageReported: 16,
  damageTriageHigh: 25,
  damageTriageMedium: 10,

  // Telematics feed health.
  telematicsNoDevice: 8,
  telematicsNoSignal: 14,
  telematicsStale: 10,
  telematicsOffline: 18,
  fuelCritical: 20,
  fuelLow: 10,
  gpsMissing: 8,
  odometerMissing: 6,
  batteryLow: 6,

  // NEW 2026-08-03 — off by default, see the header note.
  documentsEnabled: false,
  documentsExpiringWithinDays: 30,
  documentsExpiringSoon: 2,
  documentsExpired: 15,

  maintenanceDueEnabled: false,
  maintenanceDueSoonWithinMiles: 500,
  maintenanceDueSoonWithinDays: 14,
  maintenanceDueSoon: 3,
  maintenanceOverdue: 12,

  // Status bands. READY at/above readyThreshold, WATCH at/above
  // watchThreshold, ATTENTION below — unless a blocking rule fired.
  readyThreshold: 85,
  watchThreshold: 65,
});

/** Rules whose firing forces status BLOCKED regardless of the final number. */
export const BLOCKING_KEYS = Object.freeze(new Set([
  'blockMaintenanceHold',
  'blockOutOfService',
  'blockMigrationHold',
  'inspectionDamageReported',
  'damageTriageHigh',
]));

/** Keys that are on/off switches rather than point weights. */
const BOOLEAN_KEYS = Object.freeze(new Set(['documentsEnabled', 'maintenanceDueEnabled']));

/**
 * Keys that are not deductions at all — thresholds, day/mile windows. They are
 * validated on their own scale, and are never rendered as points.
 */
const NON_WEIGHT_KEYS = Object.freeze(new Set([
  'documentsExpiringWithinDays',
  'maintenanceDueSoonWithinMiles',
  'maintenanceDueSoonWithinDays',
  'readyThreshold',
  'watchThreshold',
]));

export function isWeightKey(key) {
  return !BOOLEAN_KEYS.has(key) && !NON_WEIGHT_KEYS.has(key);
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Coerce an arbitrary payload into a complete, valid rule set. Unknown keys
 * are DROPPED rather than merged — a typo must not become a stored rule that
 * silently never fires.
 */
export function normalizeTurnReadyRules(payload = {}, base = DEFAULT_TURN_READY_RULES) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_TURN_READY_RULES)) {
    const current = Object.prototype.hasOwnProperty.call(base, key) ? base[key] : fallback;
    if (BOOLEAN_KEYS.has(key)) {
      out[key] = toBoolean(src[key], current);
      continue;
    }
    let n = Math.round(toNumber(src[key], current));
    if (isWeightKey(key)) {
      // A weight is a magnitude — the sign is applied by the scorer, so a
      // negative here would silently ADD points.
      n = Math.max(0, Math.min(100, n));
    } else {
      n = Math.max(0, n);
    }
    out[key] = n;
  }
  // A watch band above the ready band would make WATCH unreachable.
  if (out.watchThreshold > out.readyThreshold) out.watchThreshold = out.readyThreshold;
  return out;
}

/** Human-readable problems with a payload. Empty array means it is usable. */
export function validateTurnReadyRules(payload = {}) {
  const errors = [];
  const src = payload && typeof payload === 'object' ? payload : {};
  for (const [key, value] of Object.entries(src)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TURN_READY_RULES, key)) {
      errors.push(`Unknown turn-ready rule "${key}".`);
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) continue;
    const n = Number(value);
    if (value !== undefined && value !== null && value !== '' && !Number.isFinite(n)) {
      errors.push(`Rule "${key}" must be a number.`);
      continue;
    }
    if (isWeightKey(key) && Number.isFinite(n) && (n < 0 || n > 100)) {
      errors.push(`Weight "${key}" must be between 0 and 100.`);
    }
    if (NON_WEIGHT_KEYS.has(key) && Number.isFinite(n) && n < 0) {
      errors.push(`Rule "${key}" cannot be negative.`);
    }
  }
  const ready = Number(src.readyThreshold);
  const watch = Number(src.watchThreshold);
  if (Number.isFinite(ready) && Number.isFinite(watch) && watch > ready) {
    errors.push('watchThreshold cannot be above readyThreshold — WATCH would be unreachable.');
  }
  return errors;
}

/** Parse the stored JSON column, falling back to defaults on anything odd. */
export function parseStoredTurnReadyRules(rulesJson) {
  if (!rulesJson) return { ...DEFAULT_TURN_READY_RULES };
  try {
    const parsed = typeof rulesJson === 'string' ? JSON.parse(rulesJson) : rulesJson;
    return normalizeTurnReadyRules(parsed);
  } catch {
    // A corrupt row must not take the planner down; defaults are always safe.
    return { ...DEFAULT_TURN_READY_RULES };
  }
}
