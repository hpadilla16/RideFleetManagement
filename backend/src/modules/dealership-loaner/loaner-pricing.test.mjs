import test from 'node:test';
import assert from 'node:assert/strict';
const { priceUpgrade, RESERVABLE_STATUSES, daysBetween } = await import('./loaner-pricing.js');

test('upgrade above entitled class bills the per-day delta x days', () => {
  const r = priceUpgrade({ chosenRate: 55, entitledRate: 30, days: 2 });
  assert.equal(r.upgradeDeltaPerDay, 25);
  assert.equal(r.estimatedUpgradeTotal, 50);
});

test('same or lower class is covered ($0)', () => {
  assert.deepEqual(priceUpgrade({ chosenRate: 30, entitledRate: 30, days: 3 }), { upgradeDeltaPerDay: 0, estimatedUpgradeTotal: 0 });
  assert.deepEqual(priceUpgrade({ chosenRate: 20, entitledRate: 30, days: 3 }), { upgradeDeltaPerDay: 0, estimatedUpgradeTotal: 0 });
});

test('no entitlement anchor (null) -> covered (delta 0)', () => {
  assert.equal(priceUpgrade({ chosenRate: 99, entitledRate: null, days: 5 }).upgradeDeltaPerDay, 0);
});

test('days floored to >=1; money rounded to cents', () => {
  assert.equal(priceUpgrade({ chosenRate: 10.005, entitledRate: 0, days: 0 }).estimatedUpgradeTotal, 10.01);
  assert.equal(priceUpgrade({ chosenRate: 12.5, entitledRate: 10, days: 4 }).estimatedUpgradeTotal, 10);
});

test('daysBetween rounds up partial days, min 1', () => {
  assert.equal(daysBetween('2026-07-01T10:00:00Z','2026-07-03T10:00:00Z'), 2);
  assert.equal(daysBetween('2026-07-01T10:00:00Z','2026-07-01T12:00:00Z'), 1);
});

test('only NEW/CONFIRMED appointments are self-service reservable', () => {
  assert.deepEqual(RESERVABLE_STATUSES, ['NEW','CONFIRMED']);
  for (const s of ['CHECKED_OUT','CHECKED_IN','CANCELLED','NO_SHOW']) {
    assert.ok(!RESERVABLE_STATUSES.includes(s), s+' must not be reservable');
  }
});
