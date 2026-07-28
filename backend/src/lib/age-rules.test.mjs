/**
 * Age rules evaluator — unit tests (LAX meeting 2026-07-28).
 * Pure lib: no prisma/fetch. Run: npm run test:age-rules
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAgeRules,
  ageOnDate,
  ageRuleBlockMessage,
  AGE_RULE_STATUS,
  DEFAULT_MIN_RENTAL_AGE,
  DEFAULT_UNDERAGE_FEE_MAX_AGE,
} from './age-rules.js';

const PICKUP = '2026-08-01T10:00:00Z';
const LAX_CFG = { ageRulesEnforced: true, chargeAgeMin: 21, underageFeeMaxAge: 24 };

function dobForAge(age, pickup = PICKUP) {
  const p = new Date(pickup);
  // Born (age) years before pickup, one month earlier → unambiguously that age.
  return new Date(Date.UTC(p.getUTCFullYear() - age, p.getUTCMonth() - 1, 15));
}

test('ageOnDate: whole-year math incl. not-yet-birthday', () => {
  assert.equal(ageOnDate('2004-09-15', PICKUP), 21); // birthday next month → still 21
  assert.equal(ageOnDate('2004-07-15', PICKUP), 22);
  assert.equal(ageOnDate(null, PICKUP), null);
  assert.equal(ageOnDate('garbage', PICKUP), null);
});

test('not enforced: never blocks, never fees — regardless of age or missing DOB', () => {
  for (const dob of [null, dobForAge(19), dobForAge(22), dobForAge(40)]) {
    const evaln = evaluateAgeRules({ dateOfBirth: dob, pickupAt: PICKUP, locationConfig: {} });
    assert.equal(evaln.status, AGE_RULE_STATUS.NOT_ENFORCED);
    assert.equal(evaln.blocking, false);
    assert.equal(evaln.feeApplies, false);
  }
});

test('enforced + no DOB: DOB_REQUIRED blocks (Hector: import ok, checkout blocked until customer info complete)', () => {
  const evaln = evaluateAgeRules({ dateOfBirth: null, pickupAt: PICKUP, locationConfig: LAX_CFG });
  assert.equal(evaln.status, AGE_RULE_STATUS.DOB_REQUIRED);
  assert.equal(evaln.blocking, true);
  assert.ok(ageRuleBlockMessage(evaln));
});

test('enforced: under 21 hard-blocks', () => {
  const evaln = evaluateAgeRules({ dateOfBirth: dobForAge(20), pickupAt: PICKUP, locationConfig: LAX_CFG });
  assert.equal(evaln.status, AGE_RULE_STATUS.UNDER_MIN);
  assert.equal(evaln.blocking, true);
  assert.equal(evaln.feeApplies, false);
  assert.match(ageRuleBlockMessage(evaln), /age 20.*minimum.*21/);
});

test('enforced: 21-24 band → no block, mandatory fee applies (inclusive bounds)', () => {
  for (const age of [21, 22, 23, 24]) {
    const evaln = evaluateAgeRules({ dateOfBirth: dobForAge(age), pickupAt: PICKUP, locationConfig: LAX_CFG });
    assert.equal(evaln.status, AGE_RULE_STATUS.UNDERAGE_BAND, `age ${age}`);
    assert.equal(evaln.blocking, false);
    assert.equal(evaln.feeApplies, true);
  }
  const ok = evaluateAgeRules({ dateOfBirth: dobForAge(25), pickupAt: PICKUP, locationConfig: LAX_CFG });
  assert.equal(ok.status, AGE_RULE_STATUS.OK);
  assert.equal(ok.feeApplies, false);
});

test('enforced: chargeAgeMax ceiling blocks when configured, ignored when absent', () => {
  const withMax = evaluateAgeRules({
    dateOfBirth: dobForAge(80), pickupAt: PICKUP,
    locationConfig: { ...LAX_CFG, chargeAgeMax: 75 },
  });
  assert.equal(withMax.status, AGE_RULE_STATUS.ABOVE_MAX);
  assert.equal(withMax.blocking, true);
  const noMax = evaluateAgeRules({ dateOfBirth: dobForAge(80), pickupAt: PICKUP, locationConfig: LAX_CFG });
  assert.equal(noMax.status, AGE_RULE_STATUS.OK);
});

test('implausible DOB blocks with its own status (not UNDER_MIN)', () => {
  const evaln = evaluateAgeRules({ dateOfBirth: '1850-01-01', pickupAt: PICKUP, locationConfig: LAX_CFG });
  assert.equal(evaln.status, AGE_RULE_STATUS.DOB_IMPLAUSIBLE);
  assert.equal(evaln.blocking, true);
});

test('defaults: min 21 / band top 24 when config keys are absent', () => {
  const cfg = { ageRulesEnforced: true };
  const evaln = evaluateAgeRules({ dateOfBirth: dobForAge(22), pickupAt: PICKUP, locationConfig: cfg });
  assert.equal(evaln.minAge, DEFAULT_MIN_RENTAL_AGE);
  assert.equal(evaln.bandMaxAge, DEFAULT_UNDERAGE_FEE_MAX_AGE);
  assert.equal(evaln.status, AGE_RULE_STATUS.UNDERAGE_BAND);
});

test('misconfigured band top below min collapses to [min..min] instead of disabling', () => {
  const cfg = { ageRulesEnforced: true, chargeAgeMin: 23, underageFeeMaxAge: 21 };
  const at23 = evaluateAgeRules({ dateOfBirth: dobForAge(23), pickupAt: PICKUP, locationConfig: cfg });
  assert.equal(at23.status, AGE_RULE_STATUS.UNDERAGE_BAND);
  const at24 = evaluateAgeRules({ dateOfBirth: dobForAge(24), pickupAt: PICKUP, locationConfig: cfg });
  assert.equal(at24.status, AGE_RULE_STATUS.OK);
});

test('enforcement flag must be a literal true (a truthy string does not arm the gate)', () => {
  const evaln = evaluateAgeRules({
    dateOfBirth: dobForAge(19), pickupAt: PICKUP,
    locationConfig: { ageRulesEnforced: 'yes' },
  });
  assert.equal(evaln.status, AGE_RULE_STATUS.NOT_ENFORCED);
});
