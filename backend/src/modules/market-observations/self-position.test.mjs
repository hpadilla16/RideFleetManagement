/**
 * Measure, don't model (2026-09-10).
 *
 * The load-bearing test is the first one, and it is the real case: IRC's CCAR
 * base is $14.14, the model claimed the customer therefore sees $20.72 and
 * ranked them DEAREST of four, and their own listing was observed at $13.00
 * against rivals at $15.00 and $15.67 — CHEAPEST. Same class, same day, same
 * pool, opposite answers. This module exists so the observed one wins.
 *
 * Pure: no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { splitSelfAndRivals, measureSelfBaseRatio, buildPositionForDate, describeSelfCoverage, latestPerSupplier, TIER,
  ratioWindowStart, resolveRatio, measureLocationRatio, RATIO_SOURCE, DEFAULT_RATIO_WINDOW_DAYS, MIN_RATIO_SAMPLE } =
  await import('./self-position.js');

// IRC sells as ZezGo; everyone else is a rival.
const isOwn = (s) => /zezgo/i.test(String(s));
const T = (h) => new Date(`2026-09-10T${String(h).padStart(2, '0')}:00:00Z`);
const row = (supplier, price, hour = 4) => ({ supplier, price, observedAt: T(hour) });

// ---------------------------------------------------------------------------
test('THE REAL CASE: observed beats modelled, and they disagree completely', () => {
  // 2026-09-11 at SJU: ours $13.00, rivals $15.00 and $15.67. Base $14.14.
  const rows = [row('ZezGo', 13.0), row('Payless', 15.0), row('Advantage', 15.67)];
  const { self, rivals } = splitSelfAndRivals(rows, isOwn);
  const p = buildPositionForDate({ selfRows: self, rivalRows: rivals, base: 14.14, pickupDate: '2026-09-11' });

  assert.equal(p.tier, TIER.OBSERVED);
  assert.equal(p.position, 1, 'cheapest — the fact');
  assert.equal(p.of, 3);
  assert.equal(p.cheapest, true);
  assert.equal(p.ourListed, 13.0, 'our OBSERVED listing, not our base times anything');
  assert.equal(p.ourListedSource, 'ZezGo');

  // What the old modelled path said, for the record: 14.14 x 1.4652 = 20.72,
  // which is dearer than every rival.
  const modelled = 14.14 * 1.4652;
  assert.ok(modelled > 15.67, 'the model ranked them last');
  assert.notEqual(p.position, 3, 'and it was wrong');
});

test('OBSERVED needs no base at all — the base is irrelevant to a fact', () => {
  const { self, rivals } = splitSelfAndRivals([row('ZezGo', 13), row('Hertz', 20)], isOwn);
  for (const base of [null, 0, 14.14, 999]) {
    const p = buildPositionForDate({ selfRows: self, rivalRows: rivals, base });
    assert.equal(p.tier, TIER.OBSERVED);
    assert.equal(p.ourListed, 13, `base ${base} must not move an observed listing`);
    assert.equal(p.position, 1);
  }
});

test('our own brand never counts as a rival', () => {
  const { self, rivals } = splitSelfAndRivals([row('ZezGo', 13), row('zezgo car rental', 12), row('Hertz', 20)], isOwn);
  assert.equal(self.length, 2);
  assert.deepEqual(rivals.map((r) => r.supplier), ['Hertz']);
  const p = buildPositionForDate({ selfRows: self, rivalRows: rivals });
  assert.equal(p.of, 2, 'us plus one rival, not three');
  assert.equal(p.suppliersSeen, 1);
});

// ---------------------------------------------------------------------------
test('ESTIMATED is used only when our listing is missing, and it says so', () => {
  const { self, rivals } = splitSelfAndRivals([row('Payless', 15), row('Advantage', 15.67)], isOwn);
  assert.equal(self.length, 0);
  const p = buildPositionForDate({ selfRows: self, rivalRows: rivals, base: 14.14, ratio: 0.97 });
  assert.equal(p.tier, TIER.ESTIMATED);
  assert.equal(p.ourListed, 13.72, '14.14 x 0.97');
  assert.equal(p.ratioUsed, 0.97);
  assert.equal(p.ratioAssumed, false);
  assert.equal(p.position, 1);
});

test('with no measured ratio the estimate assumes 1 and FLAGS it', () => {
  // Assuming 1 is defensible — the measurement put CCAR at 0.919-1.037 — but a
  // number nobody measured must never look like one that was.
  const { rivals } = splitSelfAndRivals([row('Payless', 15)], isOwn);
  const p = buildPositionForDate({ selfRows: [], rivalRows: rivals, base: 14.14 });
  assert.equal(p.tier, TIER.ESTIMATED);
  assert.equal(p.ratioAssumed, true);
  assert.equal(p.ratioUsed, 1);
  assert.equal(p.ourListed, 14.14);
});

test('no rivals is UNKNOWN — never "you are the cheapest" against nobody', () => {
  // The FJAR case: zero open-air quotes at SJU all month.
  const p = buildPositionForDate({ selfRows: [row('ZezGo', 115)], rivalRows: [], base: 115 });
  assert.equal(p.tier, TIER.UNKNOWN);
  assert.equal(p.position, null);
  assert.equal(p.cheapest, false);
  assert.equal(p.of, 0);
});

test('rivals but neither a listing nor a usable base is UNKNOWN, not a guess', () => {
  for (const base of [null, 0, -5, 'abc']) {
    const p = buildPositionForDate({ selfRows: [], rivalRows: [row('Hertz', 20)], base });
    assert.equal(p.tier, TIER.UNKNOWN, `base ${JSON.stringify(base)}`);
    assert.equal(p.position, null);
  }
});

test('a tie leaves us cheapest: only a STRICTLY lower price outranks us', () => {
  const { self, rivals } = splitSelfAndRivals([row('ZezGo', 13.33), row('Advantage', 13.33)], isOwn);
  const p = buildPositionForDate({ selfRows: self, rivalRows: rivals });
  assert.equal(p.position, 1, 'the real CFAR 2026-09-11 case');
  assert.equal(p.cheapest, true);
});

// ---------------------------------------------------------------------------
// The ratio: its SPREAD is the finding, not its midpoint
// ---------------------------------------------------------------------------
test('the measured ratio reports its range, and the real CCAR numbers land where they did', () => {
  // Six observed listings for a $14.14 base: 13.00, 13.33, 13.33, 14.67, 14.67, 14.67
  const rows = [13.0, 13.33, 13.33, 14.67, 14.67, 14.67].map((p, i) => row('ZezGo', p, i + 1));
  const r = measureSelfBaseRatio(rows, 14.14);
  assert.equal(r.n, 6);
  assert.equal(r.min, 0.9194);
  assert.equal(r.max, 1.0375);
  assert.ok(r.median > 0.94 && r.median < 1.04, `median ${r.median}`);
  assert.ok(r.spreadPct > 12 && r.spreadPct < 13, `spread ${r.spreadPct}%`);
  assert.ok(r.max < 1.4, 'nowhere near the 1.4652 the model assumed');
});

test('one observation is a ratio of one observation — n travels with it', () => {
  // CFAR: a single listing at 0.702. Usable, but the caller must see n=1.
  const r = measureSelfBaseRatio([row('ZezGo', 13.33)], 18.99);
  assert.equal(r.n, 1);
  assert.equal(r.median, 0.7019, '13.33 / 18.99, kept to four decimals');
  assert.equal(r.min, r.max);
  assert.equal(r.spreadPct, 0);
});

test('no observations, or no base, is n=0 and nulls — not 1', () => {
  // Returning 1 here would silently promise a calibration nobody made.
  for (const [rows, base] of [[[], 14.14], [[row('ZezGo', 13)], null], [[row('ZezGo', 13)], 0], [[row('ZezGo', 0)], 14.14]]) {
    const r = measureSelfBaseRatio(rows, base);
    assert.equal(r.n, 0);
    assert.equal(r.median, null);
  }
});

// ---------------------------------------------------------------------------
test('latest per supplier, not cheapest per supplier', () => {
  const l = latestPerSupplier([row('Hertz', 30, 2), row('Hertz', 55, 6), row('Avis', 40, 4)]);
  assert.deepEqual(l.map((r) => [r.supplier, r.price]), [['Avis', 40], ['Hertz', 55]]);
});

test('coverage says how much of the window needs no model', () => {
  // The number that decides how much the model still matters: CCAR 6 of 13.
  const byDate = new Map([
    ['2026-09-11', { tier: TIER.OBSERVED }], ['2026-09-12', { tier: TIER.ESTIMATED }],
    ['2026-09-13', { tier: TIER.OBSERVED }], ['2026-09-14', { tier: TIER.UNKNOWN }],
  ]);
  const c = describeSelfCoverage(byDate);
  assert.deepEqual(c, { dates: 4, observed: 2, estimated: 1, unknown: 1, observedPct: 50 });
});

test('never throws on junk', () => {
  for (const args of [undefined, {}, { selfRows: null, rivalRows: 'x' }, { rivalRows: [null, 3, {}] }]) {
    const p = buildPositionForDate(args);
    assert.ok(Object.values(TIER).includes(p.tier));
  }
  assert.deepEqual(splitSelfAndRivals(null, null), { self: [], rivals: [] });
  assert.equal(describeSelfCoverage(null).dates, 0);
});

// ---------------------------------------------------------------------------
// The ratio window, and the fallback hierarchy (2026-09-10).
//
// Four SJU classes read UNCALIBRATED purely because the ratio was measured in
// the same 24 hours as the ladder: CFAR has 979 of our own listings over 27
// days and 3 in the last one. But the base MOVED during those 30 days (56
// suggestions applied), and dividing an old listing by today's base measures
// the price change, not the channel — which is how CFAR's ratio blew out to
// 0.702-3.809.
// ---------------------------------------------------------------------------
test('THE WINDOW: it looks back, but never past the last base change', () => {
  const now = new Date('2026-09-10T20:00:00Z');
  const plain = ratioWindowStart({ now, days: 14 });
  assert.equal(plain.toISOString().slice(0, 10), '2026-08-27');

  // A base that moved four days ago truncates it: nothing before that is
  // evidence about THIS base.
  const truncated = ratioWindowStart({ now, days: 14, baseChangedAt: new Date('2026-09-06T05:00:00Z') });
  assert.equal(truncated.toISOString(), '2026-09-06T05:00:00.000Z');

  // A base that moved long ago does not extend the window.
  const old = ratioWindowStart({ now, days: 14, baseChangedAt: new Date('2026-01-01T00:00:00Z') });
  assert.equal(old.toISOString().slice(0, 10), '2026-08-27');
});

test('a rate edited an hour ago has nothing to measure — and that is the honest answer', () => {
  const now = new Date('2026-09-10T20:00:00Z');
  const start = ratioWindowStart({ now, days: 14, baseChangedAt: new Date('2026-09-10T19:00:00Z') });
  assert.ok(start > new Date('2026-09-10T18:00:00Z'), 'the window is one hour wide, so almost nothing qualifies');
});

test('junk dates fall back to the plain window rather than throwing', () => {
  const now = new Date('2026-09-10T20:00:00Z');
  for (const bad of [null, undefined, 'nope', new Date('x')]) {
    assert.equal(ratioWindowStart({ now, days: 14, baseChangedAt: bad }).toISOString().slice(0, 10), '2026-08-27');
  }
  assert.equal(ratioWindowStart({}) instanceof Date, true);
  assert.equal(DEFAULT_RATIO_WINDOW_DAYS, 14);
});

// ---------------------------------------------------------------------------
test('THE HIERARCHY: a class with enough of its own listings wins', () => {
  const r = resolveRatio({
    classRatio: { n: 7, median: 0.96, spreadPct: 12.9 },
    locationRatio: { n: 400, median: 0.88 },
  });
  assert.deepEqual(r, { ratio: 0.96, source: RATIO_SOURCE.CLASS, n: 7, spreadPct: 12.9 });
});

test('one or two of its own listings is anecdote, not calibration — the location answers', () => {
  // ICAR: 7 rows on 2 days. Same channel as every other class at the airport,
  // so the airport's own evidence is better than the class's scraps.
  for (const n of [0, 1, 2]) {
    const r = resolveRatio({ classRatio: { n, median: 1.9 }, locationRatio: { n: 400, median: 0.88 } });
    assert.equal(r.source, RATIO_SOURCE.LOCATION, );
    assert.equal(r.ratio, 0.88);
  }
  assert.equal(MIN_RATIO_SAMPLE, 3);
});

test('neither has a sample: assume 1 and SAY it was assumed', () => {
  const r = resolveRatio({ classRatio: { n: 0, median: null }, locationRatio: { n: 1, median: 2 } });
  assert.equal(r.source, RATIO_SOURCE.ASSUMED);
  assert.equal(r.ratio, 1);
  assert.equal(resolveRatio({}).source, RATIO_SOURCE.ASSUMED);
  assert.equal(resolveRatio().ratio, 1);
});

test('a nonsense median is not a ratio, however big its n', () => {
  for (const median of [0, -1, null, 'abc']) {
    assert.equal(resolveRatio({ classRatio: { n: 500, median } }).source, RATIO_SOURCE.ASSUMED);
  }
});

test('the two are never averaged — a blended ratio describes nothing', () => {
  const r = resolveRatio({ classRatio: { n: 5, median: 0.5 }, locationRatio: { n: 500, median: 1.5 } });
  assert.equal(r.ratio, 0.5, 'the class ratio, untouched');
});

// ---------------------------------------------------------------------------
test('the location ratio pools every class against ITS OWN base', () => {
  // CCAR listings against a 4.14 base and CFAR against 8.99 — dividing
  // both by one number would be meaningless.
  const r = measureLocationRatio([
    { base: 14.14, selfRows: [{ price: 13.0 }, { price: 14.67 }] },
    { base: 18.99, selfRows: [{ price: 13.33 }, { price: 19.0 }] },
  ]);
  assert.equal(r.n, 4);
  assert.ok(r.min > 0.7 && r.max < 1.05, `${r.min}..${r.max}`);
});

test('a class with no usable base contributes nothing rather than poisoning the pool', () => {
  const r = measureLocationRatio([
    { base: 0, selfRows: [{ price: 50 }] },
    { base: null, selfRows: [{ price: 60 }] },
    { base: 10, selfRows: [{ price: 10 }] },
  ]);
  assert.equal(r.n, 1);
  assert.equal(r.median, 1);
});

test('measureLocationRatio never throws on junk', () => {
  for (const v of [null, undefined, [], [null], [{ base: 5 }], [{ selfRows: [{}] }]]) {
    assert.equal(typeof measureLocationRatio(v).n, 'number');
  }
});
