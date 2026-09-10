/**
 * The scoped claim (2026-09-10).
 *
 * Hector: "que nosotros si decimos: mira, para HOY, desde la hora del scrape,
 * tu si eres el mas barato." A fact with its hour and its scope, not a forecast.
 *
 * The load-bearing tests are the first two: the ladder is ONE pickup date (the
 * old one mixed fifty, where the cheapest rival for a class ranged $15.86 to
 * $135.82 — a 756% spread that made every rank look terrible), and it takes the
 * LATEST quote per supplier, not their cheapest across a window.
 *
 * Pure: no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildRankClaim, latestPerSupplier, describeDurability, claimSentence, CLAIM } =
  await import('./market-claim.js');

const T = (h) => new Date(`2026-09-10T${String(h).padStart(2, '0')}:00:00Z`);
const row = (supplier, price, hour = 4) => ({ supplier, price, observedAt: T(hour) });

// ---------------------------------------------------------------------------
test('THE CLAIM: cheapest is stated as a fact, with the hour and the scope', () => {
  const c = buildRankClaim({
    rows: [row('Routes', 42.7), row('Zezgo', 47.18), row('U-Save', 53.68)],
    yourAllIn: 40,
    pickupDate: '2026-09-11',
    asOf: T(4),
    suppliersKnown: 9,
  });
  assert.equal(c.verdict, CLAIM.CHEAPEST);
  assert.equal(c.rank, 1);
  assert.equal(c.of, 4, 'us plus the three rivals we saw');
  assert.equal(c.suppliersSeen, 3);
  assert.equal(c.suppliersKnown, 9, 'and it admits what it did not see');
  assert.equal(c.pickupDate, '2026-09-11');
  assert.equal(c.gapToNext, 2.7, 'room before the next rival undercuts us');
  assert.equal(c.gapToBeat, null, 'nothing to beat when you are first');
  assert.match(claimSentence(c), /^Cheapest for 2026-09-11 as of .*3 agencies \(3 of 9 agencies that quote it\)$/);
});

test('the LATEST quote per supplier wins, not their cheapest', () => {
  // Cheapest-per-supplier answers "the best this agency has offered lately",
  // which is not what they are charging right now.
  const ladder = latestPerSupplier([
    { supplier: 'Routes', price: 30, observedAt: T(2) },
    { supplier: 'Routes', price: 55, observedAt: T(6) },
    { supplier: 'Zezgo', price: 40, observedAt: T(4) },
  ]);
  assert.deepEqual(ladder.map((r) => [r.supplier, r.price]), [['Zezgo', 40], ['Routes', 55]]);
});

test('one supplier spelled two ways is ONE competitor', () => {
  const ladder = latestPerSupplier([row('U-Save', 50), row('u-save', 44, 6)]);
  assert.equal(ladder.length, 1);
  assert.equal(ladder[0].price, 44, 'the later quote');
});

test('an anonymous row is not a competitor', () => {
  // Kayak leaves the supplier blank on some rows; a blank cannot be undercut.
  const ladder = latestPerSupplier([row('', 10), row(null, 12), row('   ', 8), row('Hertz', 50)]);
  assert.deepEqual(ladder.map((r) => r.supplier), ['Hertz']);
});

// ---------------------------------------------------------------------------
test('NEVER "#5 of 4": being dearest is said in words', () => {
  // The old card printed rank = ladder.length + 1, so a card could read "#5 of
  // 4 vendors" and look broken.
  const c = buildRankClaim({ rows: [row('A', 20), row('B', 25), row('C', 30)], yourAllIn: 55, pickupDate: '2026-09-11' });
  assert.equal(c.verdict, CLAIM.MOST_EXPENSIVE);
  assert.equal(c.rank, 4);
  assert.equal(c.of, 4, 'four prices exist and ours is the last of them');
  assert.equal(c.gapToBeat, 35, 'what it would take to lead');
  assert.match(claimSentence(c), /^Dearest of 4 for 2026-09-11/);
});

test('a middle position reports both gaps', () => {
  const c = buildRankClaim({ rows: [row('A', 20), row('B', 40)], yourAllIn: 30, pickupDate: '2026-09-11' });
  assert.equal(c.verdict, CLAIM.MID);
  assert.equal(c.rank, 2);
  assert.equal(c.gapToBeat, 10, 'to become cheapest');
  assert.equal(c.gapToNext, 10, 'before the one above matters');
});

test('a tie is not an undercut: equal price keeps the better rank', () => {
  const c = buildRankClaim({ rows: [row('A', 30)], yourAllIn: 30, pickupDate: '2026-09-11' });
  assert.equal(c.rank, 1, 'nobody is CHEAPER than us');
  assert.equal(c.verdict, CLAIM.CHEAPEST);
});

// ---------------------------------------------------------------------------
test('no rivals is NO_DATA — never "you are the cheapest"', () => {
  // The FJAR case: zero open-air quotes at SJU. Claiming to be cheapest of
  // nobody is the lie this guards against.
  const c = buildRankClaim({ rows: [], yourAllIn: 168.5, pickupDate: '2026-09-11', suppliersKnown: 0 });
  assert.equal(c.verdict, CLAIM.NO_DATA);
  assert.equal(c.rank, null);
  assert.equal(c.of, 0);
  assert.match(claimSentence(c), /No competitor quoted this class/);
});

test('no price of our own is its own verdict', () => {
  const c = buildRankClaim({ rows: [row('A', 20)], yourAllIn: null, pickupDate: '2026-09-11' });
  assert.equal(c.verdict, CLAIM.NO_PRICE);
  assert.equal(c.rank, null);
  assert.equal(c.suppliersSeen, 1, 'the market is still reported');
});

test('a zero price is not a price', () => {
  for (const v of [0, -5, '', null, undefined, 'abc']) {
    assert.equal(buildRankClaim({ rows: [row('A', 20)], yourAllIn: v }).verdict, CLAIM.NO_PRICE, String(v));
  }
});

test('asOf defaults to the newest row and is never the epoch', () => {
  const c = buildRankClaim({ rows: [row('A', 20, 3), row('B', 25, 7)], yourAllIn: 30 });
  assert.equal(c.asOf.toISOString(), T(7).toISOString());
  const undated = buildRankClaim({ rows: [{ supplier: 'A', price: 20 }], yourAllIn: 30 });
  assert.equal(undated.asOf, null, 'no timestamp is null, not 1970');
});

// ---------------------------------------------------------------------------
// Durability — separate on purpose
// ---------------------------------------------------------------------------
test('a margin INSIDE the overnight noise is called out as not a position', () => {
  // The finding that matters for LAX: "cheapest minus $1" is smaller than the
  // typical overnight move in the cheap classes (ECAR $0.78, ICAR $1.20,
  // CCAR $1.39), so the $1 lead is gone before anyone books.
  const d = describeDurability({ verdict: CLAIM.CHEAPEST, gapToNext: 1, overnightMove: 1.39 });
  assert.equal(d.durable, false);
  assert.match(d.label, /INSIDE/);
});

test('a wide margin is durable, and says against what', () => {
  const d = describeDurability({ verdict: CLAIM.CHEAPEST, gapToNext: 7.32, overnightMove: 4.48 });
  assert.equal(d.durable, true);
  assert.match(d.label, /\$7\.32 vs \$4\.48/);
});

test('durability measures the gap that can actually move you', () => {
  // Cheapest → the rung above is what takes the lead away. Not cheapest → the
  // distance you would have to close to take it.
  assert.equal(describeDurability({ verdict: CLAIM.MID, gapToBeat: 10, gapToNext: 0.5, overnightMove: 2 }).margin, 10);
  assert.equal(describeDurability({ verdict: CLAIM.CHEAPEST, gapToBeat: null, gapToNext: 0.5, overnightMove: 2 }).margin, 0.5);
});

test('no noise measured yet: durable is null, never a guess', () => {
  const d = describeDurability({ verdict: CLAIM.CHEAPEST, gapToNext: 5, overnightMove: null });
  assert.equal(d.durable, null);
  assert.equal(d.label, null);
});

test('never throws on junk', () => {
  for (const args of [undefined, {}, { rows: null, yourAllIn: 'x' }, { rows: [null, 1, 'a'], yourAllIn: 10 }]) {
    const c = buildRankClaim(args);
    assert.ok(typeof c.verdict === 'string');
    assert.equal(typeof claimSentence(c), 'string');
  }
  assert.equal(claimSentence(null), null);
});
