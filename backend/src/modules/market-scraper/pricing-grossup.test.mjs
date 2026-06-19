import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grossupFactor, customerAllInFromBase, baseFromCustomerAllIn, taxesFraction,
} from './pricing-grossup.js';

// SJU / ZezGo config Hector gave: Titanium, PR tax 11.5% + airport 10.5% = 22%, brokerage 20.1%.
const SJU = {
  connectionType: 'TITANIUM',
  taxes: [{ name: 'PR tax', pct: 11.5 }, { name: 'Airport fee', pct: 10.5 }],
  brokeragePct: 20.1,
};

test('taxesFraction sums the components', () => {
  assert.equal(taxesFraction(SJU), 0.22);
});

test('TITANIUM forward matches Hector\'s example: base 53.69 → 78.67', () => {
  // 53.69 × 1.22 × 1.201 = 78.668...
  assert.equal(customerAllInFromBase(53.69, SJU), 78.67);
});

test('TITANIUM grossup factor is compounding (1.22 × 1.201)', () => {
  assert.ok(Math.abs(grossupFactor(SJU) - 1.46522) < 1e-6);
});

test('TITANIUM inverse round-trips: all-in 78.67 → base ≈ 53.69', () => {
  const base = baseFromCustomerAllIn(78.67, SJU);
  assert.ok(Math.abs(base - 53.69) <= 0.01, `got ${base}`);
});

test('TITANIUM: to undercut a competitor all-in by $1, upload a much lower base', () => {
  // Competitor all-in 78.67; target 77.67; base must be ~53.01 — NOT 77.67.
  const base = baseFromCustomerAllIn(77.67, SJU);
  assert.ok(Math.abs(base - 53.01) <= 0.02, `got ${base}`);
  // And uploading that base lands us back just under the competitor.
  assert.ok(customerAllInFromBase(base, SJU) <= 78.67);
});

test('AMADEUS is additive: base×(1+brokerage) + base×taxes', () => {
  const AMA = { connectionType: 'AMADEUS', taxes: [{ pct: 22 }], brokeragePct: 20.1 };
  // factor = 1 + 0.201 + 0.22 = 1.421
  assert.ok(Math.abs(grossupFactor(AMA) - 1.421) < 1e-9);
  assert.equal(customerAllInFromBase(100, AMA), 142.1);
  assert.ok(Math.abs(baseFromCustomerAllIn(142.1, AMA) - 100) <= 0.01);
});

test('AMADEUS vs TITANIUM differ for the same inputs', () => {
  const base = 100;
  const ama = customerAllInFromBase(base, { connectionType: 'AMADEUS', taxes: [{ pct: 22 }], brokeragePct: 20.1 });
  const tit = customerAllInFromBase(base, { connectionType: 'TITANIUM', taxes: [{ pct: 22 }], brokeragePct: 20.1 });
  assert.notEqual(ama, tit); // 142.1 vs 146.52
  assert.ok(tit > ama);
});

test('bad inputs never throw', () => {
  assert.equal(customerAllInFromBase(null, SJU), null);
  assert.equal(baseFromCustomerAllIn('x', SJU), null);
  assert.equal(grossupFactor({}), 1); // no taxes/brokerage → factor 1
});
