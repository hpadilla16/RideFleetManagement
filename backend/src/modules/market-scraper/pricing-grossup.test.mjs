import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  grossupFactor, customerAllInFromBase, baseFromCustomerAllIn, taxesFraction, flatPerDay,
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

// LAX config Hector gave 2026-07-25: Vehicle License Fee is FLAT $2.00/day
// (brokerage % still pending — 0 until he provides it).
const LAX = {
  connectionType: 'TITANIUM',
  taxes: [{ name: 'Vehicle License Fee', amountPerDay: 2 }],
  brokeragePct: 0,
};

test('flat per-day fee: SJU config (pct-only) sums to 0 — legacy math byte-identical', () => {
  assert.equal(flatPerDay(SJU), 0);
  assert.equal(customerAllInFromBase(53.69, SJU), 78.67); // unchanged
});

test('LAX VLF: forward adds the flat $2 after the factor', () => {
  assert.equal(flatPerDay(LAX), 2);
  // factor = 1 (no pct, no brokerage) → all_in = base + 2
  assert.equal(customerAllInFromBase(20, LAX), 22);
});

test('LAX VLF: inverse subtracts the flat fee BEFORE dividing', () => {
  assert.equal(baseFromCustomerAllIn(22, LAX), 20);
  // Mixed pct + flat: all_in = base×1.1 + 2 → base = (target−2)/1.1
  const MIX = { connectionType: 'TITANIUM', taxes: [{ pct: 10 }, { amountPerDay: 2 }], brokeragePct: 0 };
  assert.equal(customerAllInFromBase(20, MIX), 24);
  assert.equal(baseFromCustomerAllIn(24, MIX), 20);
});

test('a target at/below the flat fees yields NO base (fail-closed), never zero/negative money', () => {
  assert.equal(baseFromCustomerAllIn(2, LAX), null);
  assert.equal(baseFromCustomerAllIn(1.5, LAX), null);
});

test('flat fee round-trips under a real factor (undercut math stays exact)', () => {
  const cfg = { connectionType: 'TITANIUM', taxes: [{ pct: 22 }, { amountPerDay: 2 }], brokeragePct: 20.1 };
  const base = baseFromCustomerAllIn(77.67, cfg);
  assert.ok(customerAllInFromBase(base, cfg) <= 77.68, `round trip ${customerAllInFromBase(base, cfg)}`);
});
