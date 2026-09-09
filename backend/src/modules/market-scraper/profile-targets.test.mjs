/**
 * Where a scrape's suggestions land, per brand (2026-09-09).
 *
 * The load-bearing case is the BACK-COMPATIBILITY one: a profile with no target
 * rows must resolve to exactly the single target it has always had. That is
 * every profile in production, and it is what lets the correction path be
 * rewritten to loop without changing a single existing profile's behaviour.
 *
 * Second: a target overrides the profile only where it SAYS something. Reading
 * an absent amount as zero would silently turn "cheapest minus a dollar" into
 * "match the cheapest" across an airport.
 *
 * No DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  resolveProfileTargets, effectiveStrategy, autoApplyTargets, assertTargetIsUnique,
} = await import('./profile-targets.service.js');

const PROFILE = {
  id: 'p1',
  targetRateId: 'rate-house',
  autoApply: false,
  strategy: 'CHEAPEST_MINUS_AMOUNT',
  strategyAmount: 1,
  strategyPct: null,
  strategyFloor: 7,
};

const db = (rows) => ({ marketScrapeProfileTarget: { findMany: async () => rows } });

// ---------------------------------------------------------------------------
// Back-compatibility
// ---------------------------------------------------------------------------
test('NO target rows: exactly the one target the profile has always had', async () => {
  const out = await resolveProfileTargets(PROFILE, { prisma: db([]) });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    id: null,
    franchiseId: null,
    rateId: 'rate-house',
    autoApply: false,
    legacy: true,
    strategy: 'CHEAPEST_MINUS_AMOUNT',
    strategyAmount: 1,
    strategyPct: null,
    strategyFloor: 7,
  });
});

test('the legacy target still answers to the PROFILE\'s autoApply flag', async () => {
  const out = await resolveProfileTargets({ ...PROFILE, autoApply: true }, { prisma: db([]) });
  assert.equal(out[0].autoApply, true);
  assert.equal(out[0].legacy, true);
});

test('a profile with no rate at all targets nothing — the pre-existing skip', async () => {
  assert.deepEqual(await resolveProfileTargets({ ...PROFILE, targetRateId: null }, { prisma: db([]) }), []);
});

test('a client without the delegate falls back to legacy rather than throwing', async () => {
  // Deploy ordering: the code can reach production a moment before the table.
  const out = await resolveProfileTargets(PROFILE, { prisma: {} });
  assert.equal(out.length, 1);
  assert.equal(out[0].legacy, true);
});

test('a failed lookup falls back to legacy, it does not lose the run', async () => {
  const boom = { marketScrapeProfileTarget: { findMany: async () => { throw new Error('pool timeout'); } } };
  const out = await resolveProfileTargets(PROFILE, { prisma: boom });
  assert.equal(out[0].legacy, true);
});

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------
test('one scrape, three brands, three Rates', async () => {
  const out = await resolveProfileTargets(PROFILE, {
    prisma: db([
      { id: 't1', franchiseId: 'f-eco', rateId: 'rate-eco', autoApply: true, strategy: null, strategyAmount: null, strategyPct: null, strategyFloor: null },
      { id: 't2', franchiseId: 'f-mex', rateId: 'rate-mex', autoApply: false, strategy: null, strategyAmount: null, strategyPct: null, strategyFloor: null },
      { id: 't3', franchiseId: null, rateId: 'rate-house', autoApply: false, strategy: null, strategyAmount: null, strategyPct: null, strategyFloor: null },
    ]),
  });
  assert.deepEqual(out.map((t) => t.rateId), ['rate-eco', 'rate-mex', 'rate-house']);
  assert.equal(out.every((t) => t.legacy === false), true);
  // Every one inherits the profile's rule until it says otherwise.
  assert.equal(out.every((t) => t.strategy === 'CHEAPEST_MINUS_AMOUNT' && t.strategyAmount === 1), true);
});

test('a brand can sit somewhere different on the ladder', async () => {
  const out = await resolveProfileTargets(PROFILE, {
    prisma: db([
      { id: 't1', franchiseId: 'f-zez', rateId: 'rate-zez', autoApply: false, strategy: 'MATCH_CHEAPEST', strategyAmount: null, strategyPct: null, strategyFloor: null },
    ]),
  });
  assert.equal(out[0].strategy, 'MATCH_CHEAPEST');
});

test('a target with no rate writes nowhere and is dropped', async () => {
  const out = await resolveProfileTargets(PROFILE, {
    prisma: db([
      { id: 't1', franchiseId: 'f-eco', rateId: null, autoApply: true, strategy: null, strategyAmount: null, strategyPct: null, strategyFloor: null },
      { id: 't2', franchiseId: 'f-mex', rateId: 'rate-mex', autoApply: true, strategy: null, strategyAmount: null, strategyPct: null, strategyFloor: null },
    ]),
  });
  assert.deepEqual(out.map((t) => t.rateId), ['rate-mex']);
});

test('missing profile is an empty list, never a throw', async () => {
  assert.deepEqual(await resolveProfileTargets(null, { prisma: db([]) }), []);
  assert.deepEqual(await resolveProfileTargets({}, { prisma: db([]) }), []);
});

// ---------------------------------------------------------------------------
// effectiveStrategy — absence is inheritance, not zero
// ---------------------------------------------------------------------------
test('a target inherits every field it does not set', () => {
  assert.deepEqual(effectiveStrategy(PROFILE, { strategy: null, strategyAmount: null, strategyPct: null, strategyFloor: null }), {
    strategy: 'CHEAPEST_MINUS_AMOUNT', strategyAmount: 1, strategyPct: null, strategyFloor: 7,
  });
});

test('setting a strategy WITHOUT an amount keeps the profile\'s amount', () => {
  // Reading the absent amount as 0 would turn "minus a dollar" into "match".
  const e = effectiveStrategy(PROFILE, { strategy: 'CHEAPEST_MINUS_AMOUNT', strategyAmount: null });
  assert.equal(e.strategyAmount, 1);
});

test('an explicit ZERO is a real value, not absence', () => {
  assert.equal(effectiveStrategy(PROFILE, { strategyAmount: 0 }).strategyAmount, 0);
  assert.equal(effectiveStrategy(PROFILE, { strategyFloor: 0 }).strategyFloor, 0);
});

test('effectiveStrategy never throws on junk', () => {
  assert.equal(effectiveStrategy(null, null).strategy, undefined);
  assert.equal(effectiveStrategy(PROFILE, null).strategyAmount, 1);
});

// ---------------------------------------------------------------------------
// autoApply is per target
// ---------------------------------------------------------------------------
test('one brand can write while another is still watched', () => {
  const targets = [
    { rateId: 'r1', autoApply: true }, { rateId: 'r2', autoApply: false },
    { rateId: null, autoApply: true },
  ];
  assert.deepEqual(autoApplyTargets(targets).map((t) => t.rateId), ['r1']);
  assert.deepEqual(autoApplyTargets(null), []);
});

// ---------------------------------------------------------------------------
// The NULL-uniqueness hole Postgres leaves open
// ---------------------------------------------------------------------------
test('the SAME brand writing the SAME rate twice is refused', async () => {
  // Postgres treats NULLs as distinct, so the unique index would accept the
  // same (profile, null, rate) twice and both would claim "everything".
  const withRow = { marketScrapeProfileTarget: { findFirst: async () => ({ id: 'existing' }) } };
  await assert.rejects(() => assertTargetIsUnique('p1', null, 'rate-ccar', { prisma: withRow }), /house target/);
  await assert.rejects(() => assertTargetIsUnique('p1', 'f-mex', 'rate-ccar', { prisma: withRow }), /already writes to this rate/);
});

test('ONE BRAND, MANY RATES is allowed — LAX keeps a Rate per class', async () => {
  // Seven single-class rates at LAX means a brand covering its classes has
  // seven rows. Keying on (profile, franchise) alone let it price exactly one.
  const seen = [];
  const db = { marketScrapeProfileTarget: { findFirst: async ({ where }) => { seen.push(where); return null; } } };
  await assertTargetIsUnique('p1', 'f-mex', 'rate-ccar', { prisma: db });
  await assertTargetIsUnique('p1', 'f-mex', 'rate-icar', { prisma: db });
  assert.deepEqual(seen.map((w) => w.rateId), ['rate-ccar', 'rate-icar']);
  assert.equal(seen.every((w) => w.profileId === 'p1' && w.franchiseId === 'f-mex'), true);
});

test('editing the row that already exists is allowed', async () => {
  const withRow = { marketScrapeProfileTarget: { findFirst: async () => ({ id: 'existing' }) } };
  await assertTargetIsUnique('p1', null, 'rate-ccar', { prisma: withRow, ignoreId: 'existing' });
});

test('no clash, no profile, no rate, or no delegate: silent pass', async () => {
  const empty = { marketScrapeProfileTarget: { findFirst: async () => null } };
  await assertTargetIsUnique('p1', 'f-mex', 'rate-ccar', { prisma: empty });
  await assertTargetIsUnique(null, null, 'rate-ccar', { prisma: empty });
  await assertTargetIsUnique('p1', null, null, { prisma: empty });
  await assertTargetIsUnique('p1', null, 'rate-ccar', { prisma: {} });
});
