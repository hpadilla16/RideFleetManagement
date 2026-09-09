/**
 * The self-check over real-shaped scrape data (2026-09-09).
 *
 * The target comes from the PROFILE'S OWN RULE, never from a number invented
 * here — inventing an anchor is the mistake Hector corrected in July, and it
 * would quietly re-price a whole airport.
 *
 * The fake client returns the same shapes Prisma does; no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { targetFromStrategy, runSelfCheck } = await import('./price-self-check.service.js');
const { AXIS_TARGET, AXIS_LADDER } = await import('./price-self-check.js');

// ---------------------------------------------------------------------------
// targetFromStrategy
// ---------------------------------------------------------------------------
const MINUS1 = { strategy: 'CHEAPEST_MINUS_AMOUNT', strategyAmount: 1 };

test('cheapest minus an amount — the rule Corpusa actually runs at LAX', () => {
  assert.equal(targetFromStrategy(15.67, MINUS1), 14.67);
});

test('cheapest minus a percentage', () => {
  assert.equal(targetFromStrategy(20, { strategy: 'CHEAPEST_MINUS_PCT', strategyPct: 10 }), 18);
});

test('match cheapest', () => {
  assert.equal(targetFromStrategy(20, { strategy: 'MATCH_CHEAPEST' }), 20);
});

test('the strategy floor clamps the target up', () => {
  assert.equal(targetFromStrategy(7.5, { ...MINUS1, strategyFloor: 9 }), 9);
  assert.equal(targetFromStrategy(20, { ...MINUS1, strategyFloor: 9 }), 19, 'floor does not bind here');
});

test('an unmodelled strategy is null, NEVER a guessed number', () => {
  assert.equal(targetFromStrategy(20, { strategy: 'SOMETHING_NEW' }), null);
  assert.equal(targetFromStrategy(20, { strategy: 'CHEAPEST_MINUS_AMOUNT' }), null, 'no amount configured');
  assert.equal(targetFromStrategy(20, {}), null);
  assert.equal(targetFromStrategy(20, null), null);
});

test('no competitor to anchor on is null, and junk never throws', () => {
  for (const bad of [null, undefined, 0, -5, 'x', NaN]) {
    assert.equal(targetFromStrategy(bad, MINUS1), null);
  }
});

test('a rule that would price at or below zero yields null rather than a free car', () => {
  assert.equal(targetFromStrategy(1, { strategy: 'CHEAPEST_MINUS_AMOUNT', strategyAmount: 5 }), null);
});

// ---------------------------------------------------------------------------
// runSelfCheck
// ---------------------------------------------------------------------------
const PROFILE = { id: 'p1', name: 'LAX 1-14 Daily', ...MINUS1, strategyPct: null, strategyFloor: null };

function fakeDb({ offers = [], profiles = [PROFILE], excluded = ['MEXRENTACAR', 'Economy Rent a Car', 'Zezgo'] } = {}) {
  return {
    marketScrapeProfile: { findMany: async () => profiles },
    tenant: { findUnique: async () => ({ marketExcludedVendors: excluded }) },
    rateOffer: { findMany: async () => offers },
  };
}
const offer = (supplier, sipp, date, price) => ({
  supplier, sipp, pickupDate: new Date(`${date}T00:00:00Z`),
  dailyPrice: price, effectiveDailyPrice: price,
});
const SCOPE = { tenantId: 't1' };

test('THE LAX SHAPE: we are the cheapest and still far under our own target', async () => {
  const out = await runSelfCheck(SCOPE, {
    locationCode: 'LAX',
    prisma: fakeDb({
      offers: [
        offer('MEXRENTACAR', 'IFAR', '2026-09-15', 12),
        offer('Midway', 'IFAR', '2026-09-15', 39),
        offer('Ace', 'IFAR', '2026-09-15', 41),
        offer('U-Save', 'IFAR', '2026-09-15', 44),
      ],
    }),
  });
  const cell = out.cells[0];
  assert.equal(cell.target, 38, 'cheapest competitor 39 minus 1');
  assert.equal(cell.targetAxis, AXIS_TARGET.BELOW);
  assert.equal(cell.ladderAxis, AXIS_LADDER.CHEAPEST);
  assert.equal(cell.deltaVsTarget, -26);
  assert.equal(cell.thinLadder, false, '3 distinct competitors is a real ladder');
  assert.equal(out.summary.dollarsLeftPerDay, 26);
});

test('LADDER DEPTH counts COMPANIES, not listings', async () => {
  // Hertz five times over is still one company; the ladder is one deep.
  const out = await runSelfCheck(SCOPE, {
    locationCode: 'LAX',
    prisma: fakeDb({
      offers: [
        offer('Economy Rent a Car', 'SFAR', '2026-09-20', 14.67),
        ...[93, 95, 97, 99, 101].map((p, i) => offer('Hertz', 'SFAR', '2026-09-20', p + i * 0)),
      ],
    }),
  });
  const cell = out.cells[0];
  assert.equal(cell.rivalCount, 1);
  assert.equal(cell.thinLadder, true);
  assert.equal(out.summary.dollarsLeftPerDay, 0, 'a sample of one must not reach the headline number');
  assert.ok(out.summary.dollarsLeftPerDayThin > 0, 'but it is still reported');
});

test('somebody under us is flagged on the ladder axis', async () => {
  const out = await runSelfCheck(SCOPE, {
    locationCode: 'LAX',
    prisma: fakeDb({
      offers: [
        offer('Zezgo', 'ICAR', '2026-10-02', 32),
        offer('FlexWays', 'ICAR', '2026-10-02', 27),
        offer('Ace', 'ICAR', '2026-10-02', 35),
        offer('Midway', 'ICAR', '2026-10-02', 36),
      ],
    }),
  });
  assert.equal(out.cells[0].ladderAxis, AXIS_LADDER.UNDERCUT);
  assert.equal(out.cells[0].deltaVsCheapest, 5);
  assert.equal(out.summary.undercut, 1);
});

test('our own brands are taken from the tenant list and never counted as rivals', async () => {
  const out = await runSelfCheck(SCOPE, {
    locationCode: 'LAX',
    prisma: fakeDb({
      offers: [
        offer('MEXRENTACAR', 'ECAR', '2026-09-15', 7),
        offer('Economy Rent a Car', 'ECAR', '2026-09-15', 10),
        offer('Ace', 'ECAR', '2026-09-15', 16),
      ],
    }),
  });
  const cell = out.cells[0];
  assert.equal(cell.ours, 7, 'the cheapest of OUR brands');
  assert.equal(cell.rival, 16);
  assert.equal(cell.rivalCount, 1, 'our two brands are not rivals to each other');
});

test('per-brand attribution says WHICH brand is off', async () => {
  const out = await runSelfCheck(SCOPE, {
    locationCode: 'LAX',
    prisma: fakeDb({
      offers: [
        offer('MEXRENTACAR', 'ICAR', '2026-09-15', 12),
        offer('Zezgo', 'ICAR', '2026-09-15', 15),
        offer('Ace', 'ICAR', '2026-09-15', 30),
        offer('Midway', 'ICAR', '2026-09-15', 31),
        offer('U-Save', 'ICAR', '2026-09-15', 32),
      ],
    }),
  });
  assert.equal(out.brands.MEXRENTACAR.avgGap, -17, 'target 29, MEX at 12');
  assert.equal(out.brands.Zezgo.avgGap, -14);
});

test('NOT BEING LISTED is counted, not silently skipped', async () => {
  const out = await runSelfCheck(SCOPE, {
    locationCode: 'LAX',
    prisma: fakeDb({ offers: [offer('Ace', 'ICAR', '2026-09-15', 30), offer('Midway', 'ICAR', '2026-09-15', 31)] }),
  });
  assert.equal(out.summary.unseen, 1);
  assert.equal(out.summary.seen, 0);
  assert.equal(out.cells[0].ourPriceSeen, false);
});

test('no active profile returns an explanation, not an empty success', async () => {
  const out = await runSelfCheck(SCOPE, { locationCode: 'MIA', prisma: fakeDb({ profiles: [] }) });
  assert.match(out.note, /No active Market Intelligence profile/);
  assert.equal(out.cells.length, 0);
});

test('a mixed set of strategies at one sede is surfaced, not averaged away', async () => {
  const out = await runSelfCheck(SCOPE, {
    locationCode: 'LAX',
    prisma: fakeDb({
      profiles: [PROFILE, { ...PROFILE, id: 'p2', strategy: 'MATCH_CHEAPEST' }],
      offers: [offer('Ace', 'ICAR', '2026-09-15', 30)],
    }),
  });
  assert.equal(out.mixedStrategy, true);
});

test('missing scope or location is a 400, not a silent empty report', async () => {
  await assert.rejects(() => runSelfCheck({}, { locationCode: 'LAX', prisma: fakeDb() }), /required/);
  await assert.rejects(() => runSelfCheck(SCOPE, { prisma: fakeDb() }), /required/);
});

test('the window is clamped so one query cannot ask for a year', async () => {
  const out = await runSelfCheck(SCOPE, { locationCode: 'LAX', days: 999, prisma: fakeDb() });
  assert.equal(out.days, 30);
});
