import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUtilizationTier, resolveTierTarget, medianOf } from './pricing-tiers.js';

// Hector's ladder: <50% base · ≥50% 3rd cheapest · ≥70% 5th cheapest · ≥85% market · ≥90% market+15%.
const RULES = [
  { fromPct: 50, type: 'NTH_CHEAPEST', n: 3 },
  { fromPct: 70, type: 'NTH_CHEAPEST', n: 5 },
  { fromPct: 85, type: 'MARKET' },
  { fromPct: 90, type: 'MARKET_PCT', pct: 15 },
];

// 6 competitors ascending: 20, 25, 30, 35, 40, 60 → median = (30+35)/2 = 32.5
const PRICES = [40, 20, 60, 25, 35, 30];

test('pickUtilizationTier uses "reaches X%" (highest fromPct ≤ util)', () => {
  assert.equal(pickUtilizationTier(0.30, RULES), null);          // <50% → base margin
  assert.equal(pickUtilizationTier(0.50, RULES).n, 3);           // exactly 50% → 3rd cheapest
  assert.equal(pickUtilizationTier(0.69, RULES).n, 3);
  assert.equal(pickUtilizationTier(0.70, RULES).n, 5);           // 70% → 5th cheapest
  assert.equal(pickUtilizationTier(0.86, RULES).type, 'MARKET');
  assert.equal(pickUtilizationTier(0.95, RULES).type, 'MARKET_PCT');
});

test('medianOf handles even/odd', () => {
  assert.equal(medianOf([20, 25, 30, 35, 40, 60]), 32.5);
  assert.equal(medianOf([20, 25, 30]), 25);
  assert.equal(medianOf([]), null);
});

test('NTH_CHEAPEST picks the right rung', () => {
  assert.equal(resolveTierTarget({ type: 'NTH_CHEAPEST', n: 1 }, PRICES), 20); // cheapest
  assert.equal(resolveTierTarget({ type: 'NTH_CHEAPEST', n: 3 }, PRICES), 30); // 3rd cheapest
  assert.equal(resolveTierTarget({ type: 'NTH_CHEAPEST', n: 5 }, PRICES), 40); // 5th cheapest
});

test('NTH_CHEAPEST clamps when n exceeds the pool', () => {
  assert.equal(resolveTierTarget({ type: 'NTH_CHEAPEST', n: 99 }, PRICES), 60); // most expensive
});

test('NTH_EXPENSIVE counts from the top', () => {
  assert.equal(resolveTierTarget({ type: 'NTH_EXPENSIVE', n: 1 }, PRICES), 60); // most expensive
  assert.equal(resolveTierTarget({ type: 'NTH_EXPENSIVE', n: 2 }, PRICES), 40);
});

test('MARKET = median, MARKET_PCT = median × (1+pct)', () => {
  assert.equal(resolveTierTarget({ type: 'MARKET' }, PRICES), 32.5);
  assert.equal(resolveTierTarget({ type: 'MARKET_PCT', pct: 15 }, PRICES), 37.38); // 32.5×1.15
});

test('empty prices or unknown type → null (caller falls back to base margin)', () => {
  assert.equal(resolveTierTarget({ type: 'MARKET' }, []), null);
  assert.equal(resolveTierTarget({ type: 'NOPE' }, PRICES), null);
  assert.equal(resolveTierTarget(null, PRICES), null);
});
