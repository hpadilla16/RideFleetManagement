import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUtilizationTier, applyUtilizationAdjustment } from './pricing-utilization.js';

// Hector's canonical ladder: <40% −$3, 40–70% −$1, 70–90% match, >90% +5%.
const RULES = [
  { maxPct: 40, adjustAmount: -3 },
  { maxPct: 70, adjustAmount: -1 },
  { maxPct: 90, adjustAmount: 0 },
  { maxPct: 100, adjustPct: 5 },
];

test('pickUtilizationTier selects the right band', () => {
  assert.equal(pickUtilizationTier(0.30, RULES).adjustAmount, -3);   // 30%
  assert.equal(pickUtilizationTier(0.40, RULES).adjustAmount, -3);   // boundary inclusive
  assert.equal(pickUtilizationTier(0.55, RULES).adjustAmount, -1);   // 55%
  assert.equal(pickUtilizationTier(0.85, RULES).adjustAmount, 0);    // 85%
  assert.equal(pickUtilizationTier(0.95, RULES).adjustPct, 5);       // 95%
});

test('above all thresholds falls to the top tier', () => {
  assert.equal(pickUtilizationTier(1.0, RULES).adjustPct, 5);
});

test('null utilization or empty rules → no tier', () => {
  assert.equal(pickUtilizationTier(null, RULES), null);
  assert.equal(pickUtilizationTier(0.5, []), null);
});

test('applyUtilizationAdjustment nudges the target all-in', () => {
  // low demand 30% → −$3
  assert.equal(applyUtilizationAdjustment(77.67, 0.30, RULES), 74.67);
  // mid demand 55% → −$1
  assert.equal(applyUtilizationAdjustment(77.67, 0.55, RULES), 76.67);
  // high demand 85% → match (0)
  assert.equal(applyUtilizationAdjustment(77.67, 0.85, RULES), 77.67);
  // peak demand 95% → +5%
  assert.equal(applyUtilizationAdjustment(100, 0.95, RULES), 105);
});

test('no adjustment when utilization unknown', () => {
  assert.equal(applyUtilizationAdjustment(77.67, null, RULES), 77.67);
});

test('adjustment never returns negative', () => {
  assert.equal(applyUtilizationAdjustment(2, 0.10, [{ maxPct: 100, adjustAmount: -10 }]), 0);
});
