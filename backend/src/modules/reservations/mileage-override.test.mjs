// Per-reservation mileage exception (2026-07-25) — pure merge/normalize tests.
// The QA MAJOR these pin (A-1): clearing the field must remove ONLY a manual
// exception. The RULE's frozen mileage lives in the same JSON keys, and
// stripping it would delete a contractual cap (LAX local 150 mi/day) or a
// promised unlimited with no way back — the re-evaluation never fires on
// UI_MANUAL snapshots.
process.env.JWT_SECRET = 'test-secret-for-mileage-override-tests-0123456789';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@127.0.0.1:5/x';

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMileageOverride, mergeMileageOverride } from './reservation-pricing.service.js';
import { parseDepositRuleDecision, decideIncludedMilesPerDay, UNLIMITED_MILES } from '../../lib/deposit-rules.js';

const RULE_DECISION = JSON.stringify({
  locality: 'LOCAL', basis: 'LICENSE', localStates: ['CA'],
  securityDepositAmount: 2000, milesPerDay: 150, unlimitedMileage: false,
  evaluatedAt: '2026-07-25T00:00:00.000Z'
});

test('normalize: undefined untouched, null clears, shapes parse, garbage → undefined', () => {
  assert.equal(normalizeMileageOverride(undefined), undefined);
  assert.equal(normalizeMileageOverride(null), null);
  assert.deepEqual(normalizeMileageOverride({ unlimited: true }), { unlimited: true });
  assert.deepEqual(normalizeMileageOverride({ milesPerDay: 200.4 }), { milesPerDay: 200 });
  assert.equal(normalizeMileageOverride({ milesPerDay: 0 }), undefined);
  assert.equal(normalizeMileageOverride({ milesPerDay: -5 }), undefined);
  assert.equal(normalizeMileageOverride('x'), undefined);
});

test('merge preserves the deposit half of a rule decision', () => {
  const merged = JSON.parse(mergeMileageOverride(RULE_DECISION, { unlimited: true }));
  assert.equal(merged.locality, 'LOCAL');
  assert.equal(merged.securityDepositAmount, 2000);
  assert.equal(merged.unlimitedMileage, true);
  assert.equal(merged.milesPerDay, null);
  assert.equal(merged.mileageSource, 'UI_MANUAL');
  assert.equal(decideIncludedMilesPerDay({ decision: merged }), UNLIMITED_MILES);
});

test('A-1: clearing does NOT strip the RULE\'s own frozen mileage', () => {
  assert.equal(mergeMileageOverride(RULE_DECISION, null), RULE_DECISION);
  const decision = parseDepositRuleDecision(mergeMileageOverride(RULE_DECISION, null));
  assert.equal(decideIncludedMilesPerDay({ decision }), 150);
});

test('clearing DOES strip a manual exception, and only the mileage keys', () => {
  const withManual = mergeMileageOverride(RULE_DECISION, { milesPerDay: 300 });
  const cleared = JSON.parse(mergeMileageOverride(withManual, null));
  assert.equal(cleared.milesPerDay, undefined);
  assert.equal(cleared.unlimitedMileage, undefined);
  assert.equal(cleared.mileageSource, undefined);
  assert.equal(cleared.locality, 'LOCAL');
  assert.equal(cleared.securityDepositAmount, 2000);
  // Rule mileage is gone from the JSON after a manual roundtrip+clear — the
  // resolver falls to vehicle type / 200. Documented cost of the exception.
  assert.equal(decideIncludedMilesPerDay({ decision: cleared }), null);
});

test('manual exception on a reservation with NO decision creates a minimal one', () => {
  const merged = JSON.parse(mergeMileageOverride(null, { milesPerDay: 250 }));
  assert.equal(merged.basis, 'MANUAL');
  assert.equal(merged.milesPerDay, 250);
  assert.equal(decideIncludedMilesPerDay({ decision: merged }), 250);
});

test('clearing when nothing exists stays null; garbage json treated as absent', () => {
  assert.equal(mergeMileageOverride(null, null), null);
  const merged = JSON.parse(mergeMileageOverride('not json', { unlimited: true }));
  assert.equal(merged.basis, 'MANUAL');
  assert.equal(merged.unlimitedMileage, true);
});
