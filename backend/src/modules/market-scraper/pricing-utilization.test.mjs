import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUtilizationLookup } from './pricing-utilization.js';

// The pure tier math is tested in pricing-tiers.test.mjs. This file only guards the
// lookup's shape + that a bad/empty call degrades safely (no throw → null util).
test('buildUtilizationLookup is exported and returns a utilOf()', async () => {
  const lookup = await buildUtilizationLookup({});
  assert.equal(typeof lookup.utilOf, 'function');
  assert.equal(lookup.utilOf('CCAR', '2026-06-20'), null);
});
