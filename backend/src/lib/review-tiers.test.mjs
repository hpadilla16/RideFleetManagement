// Review-tier commission math (LAX #5). MONEY. Pins Hector's table:
// 0-9 → 0% · 10-19 → 2% · 20-29 → 3% · 30-39 → 4% · 40-60 → 5% · 61+ → 6%.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewTiers, tierPercentFor, DEFAULT_REVIEW_TIERS } from './review-tiers.js';

test("Hector's table, every boundary", () => {
  const t = DEFAULT_REVIEW_TIERS;
  assert.equal(tierPercentFor(0, t), 0);
  assert.equal(tierPercentFor(9, t), 0);
  assert.equal(tierPercentFor(10, t), 2);
  assert.equal(tierPercentFor(19, t), 2);
  assert.equal(tierPercentFor(20, t), 3);
  assert.equal(tierPercentFor(29, t), 3);
  assert.equal(tierPercentFor(30, t), 4);
  assert.equal(tierPercentFor(39, t), 4);
  assert.equal(tierPercentFor(40, t), 5);
  assert.equal(tierPercentFor(60, t), 5);
  assert.equal(tierPercentFor(61, t), 6);
  assert.equal(tierPercentFor(500, t), 6);
});

test('normalize sorts, and rejects garbage as a WHOLE (money never half-parses)', () => {
  const sorted = normalizeReviewTiers([{ minReviews: 40, pct: 5 }, { minReviews: 10, pct: 2 }]);
  assert.deepEqual(sorted, [{ minReviews: 10, pct: 2 }, { minReviews: 40, pct: 5 }]);
  assert.equal(normalizeReviewTiers(null), null);
  assert.equal(normalizeReviewTiers([]), null);
  assert.equal(normalizeReviewTiers([{ minReviews: -1, pct: 2 }]), null);
  assert.equal(normalizeReviewTiers([{ minReviews: 10, pct: 101 }]), null);
  assert.equal(normalizeReviewTiers([{ minReviews: 10.5, pct: 2 }]), null);
  // duplicate thresholds: which pct wins? → reject
  assert.equal(normalizeReviewTiers([{ minReviews: 10, pct: 2 }, { minReviews: 10, pct: 3 }]), null);
});

test('no tiers / bad count → 0% (no reviews, no commission — the ground state)', () => {
  assert.equal(tierPercentFor(50, null), 0);
  assert.equal(tierPercentFor(50, []), 0);
  assert.equal(tierPercentFor(NaN, DEFAULT_REVIEW_TIERS), 0);
  assert.equal(tierPercentFor(-3, DEFAULT_REVIEW_TIERS), 0);
});
