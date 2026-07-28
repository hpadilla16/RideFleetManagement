/**
 * Age rules at check-out — the shared evaluator (LAX meeting 2026-07-28).
 *
 * Business rule: with enforcement ON for the pickup location,
 *   - no DOB on file        → check-out cannot start (the reservation itself
 *                             imports/creates fine — Hector: "importa la
 *                             reservación pero no puede habilitar el check out
 *                             hasta que tenga todo el info del cliente")
 *   - age <  chargeAgeMin   → check-out refused (hard block, default 21)
 *   - age in [min..bandMax] → check-out proceeds WITH an underage notice and a
 *                             MANDATORY underage fee (Fee.isUnderageFee rows
 *                             linked to the location; bandMax default 24)
 *   - age >  chargeAgeMax   → hard block when that ceiling is configured
 *
 * Location config keys (Location.locationConfig JSON, all additive):
 *   ageRulesEnforced  boolean — the enforcement switch (default false; LAX on)
 *   chargeAgeMin      number  — hard minimum (pre-existing key, default 21)
 *   chargeAgeMax      number  — hard maximum (pre-existing key, 0/absent = none)
 *   underageFeeMaxAge number  — top of the fee band, inclusive (default 24)
 *
 * This module is pure — callers resolve the DOB and parse locationConfig.
 * The kiosk keeps its own evaluateIdRules (it also handles license expiry);
 * both share the same age math via ageOnDate here.
 */

import { isImplausibleAge } from './dob.js';

export const DEFAULT_MIN_RENTAL_AGE = 21;
export const DEFAULT_UNDERAGE_FEE_MAX_AGE = 24;

export const AGE_RULE_STATUS = Object.freeze({
  OK: 'OK',
  NOT_ENFORCED: 'NOT_ENFORCED',
  DOB_REQUIRED: 'DOB_REQUIRED',
  DOB_IMPLAUSIBLE: 'DOB_IMPLAUSIBLE',
  UNDER_MIN: 'UNDER_MIN',
  ABOVE_MAX: 'ABOVE_MAX',
  UNDERAGE_BAND: 'UNDERAGE_BAND',
});

/** Whole years between dob and a reference date. Null when either is missing/invalid. */
export function ageOnDate(dob, onDate) {
  const birth = dob ? new Date(dob) : null;
  const ref = onDate ? new Date(onDate) : null;
  if (!birth || !ref || Number.isNaN(birth.getTime()) || Number.isNaN(ref.getTime())) return null;
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) age -= 1;
  return age;
}

/**
 * Evaluate the age rules for one driver at one pickup.
 *
 * @param {object} params
 * @param {string|Date|null} params.dateOfBirth  the driver's DOB (or null)
 * @param {string|Date}      params.pickupAt     the moment age is measured at
 * @param {object|null}      params.locationConfig  PARSED pickup-location config
 * @returns {{
 *   enforced: boolean,
 *   status: string,            // AGE_RULE_STATUS
 *   blocking: boolean,         // true → check-out must not proceed
 *   feeApplies: boolean,       // true → the mandatory underage fee applies
 *   age: number|null,
 *   minAge: number,
 *   maxAge: number|null,
 *   bandMaxAge: number,
 * }}
 */
export function evaluateAgeRules({ dateOfBirth, pickupAt, locationConfig }) {
  const cfg = locationConfig && typeof locationConfig === 'object' ? locationConfig : {};
  const enforced = cfg.ageRulesEnforced === true;
  const minAge = Number(cfg.chargeAgeMin) > 0 ? Number(cfg.chargeAgeMin) : DEFAULT_MIN_RENTAL_AGE;
  const maxAge = Number(cfg.chargeAgeMax) > 0 ? Number(cfg.chargeAgeMax) : null;
  // The band top can never sit below the hard minimum — a misconfigured value
  // collapses the band to [minAge..minAge] instead of silently disabling it.
  const bandMaxAge = Math.max(
    minAge,
    Number(cfg.underageFeeMaxAge) > 0 ? Number(cfg.underageFeeMaxAge) : DEFAULT_UNDERAGE_FEE_MAX_AGE,
  );

  const age = ageOnDate(dateOfBirth, pickupAt);
  const base = { enforced, age, minAge, maxAge, bandMaxAge };

  if (!enforced) {
    return { ...base, status: AGE_RULE_STATUS.NOT_ENFORCED, blocking: false, feeApplies: false };
  }
  if (age === null) {
    return { ...base, status: AGE_RULE_STATUS.DOB_REQUIRED, blocking: true, feeApplies: false };
  }
  if (isImplausibleAge(age)) {
    return { ...base, status: AGE_RULE_STATUS.DOB_IMPLAUSIBLE, blocking: true, feeApplies: false };
  }
  if (age < minAge) {
    return { ...base, status: AGE_RULE_STATUS.UNDER_MIN, blocking: true, feeApplies: false };
  }
  if (maxAge !== null && age > maxAge) {
    return { ...base, status: AGE_RULE_STATUS.ABOVE_MAX, blocking: true, feeApplies: false };
  }
  if (age <= bandMaxAge) {
    return { ...base, status: AGE_RULE_STATUS.UNDERAGE_BAND, blocking: false, feeApplies: true };
  }
  return { ...base, status: AGE_RULE_STATUS.OK, blocking: false, feeApplies: false };
}

/** Human-readable message for a blocking evaluation (agent-facing, English —
 * the wizard localizes by status code; this is the API fallback text). */
export function ageRuleBlockMessage(evaluation) {
  switch (evaluation?.status) {
    case AGE_RULE_STATUS.DOB_REQUIRED:
      return 'Customer date of birth is required before check-out can start at this location.';
    case AGE_RULE_STATUS.DOB_IMPLAUSIBLE:
      return `The date of birth on file is invalid (it computes to age ${evaluation.age}). Correct it to continue.`;
    case AGE_RULE_STATUS.UNDER_MIN:
      return `Driver age ${evaluation.age} is below the minimum rental age ${evaluation.minAge} for this location.`;
    case AGE_RULE_STATUS.ABOVE_MAX:
      return `Driver age ${evaluation.age} exceeds the maximum rental age ${evaluation.maxAge} for this location.`;
    default:
      return null;
  }
}
