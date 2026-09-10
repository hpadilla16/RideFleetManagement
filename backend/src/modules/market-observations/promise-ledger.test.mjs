/**
 * The closed loop (2026-09-10).
 *
 * Production's recommendation was measured this day to deliver the configured
 * target on 0 of 14 classes, for weeks, with 56 of those applied by a human who
 * had no way to know. A ledger that grades its own promises against the
 * tenant's own observed listing is what makes that visible on day two instead
 * of never.
 *
 * The load-bearing tests: a promise is only graded against an OBSERVED listing
 * (grading an estimate with an estimate measures nothing), and an empty
 * scoreboard reads as "nothing graded", never as 100%.
 *
 * Pure: no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { recordPromise, gradePromise, scorePromises, scoreSentence, PROMISE, DEFAULT_TTL_DAYS } =
  await import('./promise-ledger.js');

const T = (d) => new Date(`2026-09-${String(d).padStart(2, '0')}T04:00:00Z`);

const promise = (over = {}) => ({
  rateId: 'rate-ccar',
  sipp: 'CCAR',
  locationCode: 'SJU',
  targetN: 2,
  base: 12.48,
  listedExpected: 12.48,
  ratioUsed: 1,
  ratioAssumed: true,
  holdsOn: 8,
  ofDates: 12,
  dates: ['2026-09-11', '2026-09-12'],
  publishedAt: T(10),
  ...over,
});

// ---------------------------------------------------------------------------
test('a promise is recorded at publish time, PENDING and ungraded', () => {
  const [p] = recordPromise([], promise());
  assert.equal(p.status, PROMISE.PENDING);
  assert.equal(p.base, 12.48);
  assert.equal(p.holdsOn, 8);
  assert.equal(p.ofDates, 12);
  assert.equal(p.observedListing, null);
  assert.equal(p.verifiedAt, null);
});

test('something with no base or no rate is not a promise and is not recorded', () => {
  // A recommendation the system refused to make ("not answerable") must not
  // enter the ledger and dilute the score.
  for (const bad of [{ base: null }, { base: 0 }, { base: -3 }, { rateId: null }, { base: 'abc' }]) {
    assert.deepEqual(recordPromise([], promise(bad)), []);
  }
});

test('a recommendation that holds ZERO dates is not a promise', () => {
  // The BLOCKED case: the tenant's floor pushes the price to where it wins
  // nothing. Recorded, it would be graded KEPT for achieving nothing.
  assert.deepEqual(recordPromise([], promise({ holdsOn: 0 })), []);
  assert.deepEqual(recordPromise([], promise({ holdsOn: null })), []);
});

test('re-publishing the same rate and target supersedes the old PENDING one', () => {
  // Otherwise two promises about the same thing both wait for one observation
  // and the score double-counts.
  const first = recordPromise([], promise({ base: 12.48 }));
  const second = recordPromise(first, promise({ base: 13.04 }));
  assert.equal(second.length, 1);
  assert.equal(second[0].base, 13.04);
});

test('a promise for a DIFFERENT target is not superseded', () => {
  const a = recordPromise([], promise({ targetN: 1 }));
  const b = recordPromise(a, promise({ targetN: 2 }));
  assert.equal(b.length, 2);
});

test('an already-graded promise is never superseded — history is history', () => {
  const graded = { ...promise(), id: 'x', status: PROMISE.KEPT };
  const out = recordPromise([graded], promise());
  assert.equal(out.length, 2);
  assert.ok(out.some((p) => p.status === PROMISE.KEPT));
});

test('the ledger is capped, newest first', () => {
  let list = [];
  for (let i = 0; i < 5; i += 1) list = recordPromise(list, promise({ rateId: `r${i}`, base: 10 + i }), { cap: 3 });
  assert.equal(list.length, 3);
  assert.equal(list[0].base, 14, 'newest first');
});

// ---------------------------------------------------------------------------
test('THE GRADE: observed listing and observed coverage decide it', () => {
  const [p] = recordPromise([], promise());
  const g = gradePromise(p, { listed: 12.40, holdsOn: 8, ofDates: 12, observedAt: T(11) });
  assert.equal(g.status, PROMISE.KEPT);
  assert.equal(g.observedListing, 12.40);
  assert.equal(g.observedHoldsOn, 8);
  assert.equal(g.observedRatio, 0.9936, 'listed / base — the calibration falls out of the grade');
  assert.equal(g.verifiedAt, T(11).toISOString());
});

test('landing BETTER than promised is still KEPT', () => {
  // We said 2nd on 8 dates; they got it on 10. The advice was not wrong.
  const [p] = recordPromise([], promise());
  assert.equal(gradePromise(p, { listed: 12.4, holdsOn: 10, ofDates: 12 }).status, PROMISE.KEPT);
});

test('falling short is MISSED, with both numbers kept', () => {
  // The real production shape: promised 8 of 12, delivered 1.
  const [p] = recordPromise([], promise());
  const g = gradePromise(p, { listed: 20.72, holdsOn: 1, ofDates: 12 });
  assert.equal(g.status, PROMISE.MISSED);
  assert.equal(g.holdsOn, 8, 'what we said');
  assert.equal(g.observedHoldsOn, 1, 'what happened');
  assert.equal(g.observedRatio, 1.6603, 'and the ratio that explains it');
});

test('no observation means it STAYS PENDING — an estimate never grades an estimate', () => {
  const [p] = recordPromise([], promise());
  for (const obs of [null, {}, { listed: null, holdsOn: 3 }, { listed: 12, holdsOn: null }]) {
    assert.equal(gradePromise(p, obs, { now: T(11) }).status, PROMISE.PENDING);
  }
});

test('a promise nobody ever observed EXPIRES rather than waiting forever', () => {
  const [p] = recordPromise([], promise({ publishedAt: T(1) }));
  const g = gradePromise(p, null, { now: T(1 + DEFAULT_TTL_DAYS + 1) });
  assert.equal(g.status, PROMISE.EXPIRED);
  assert.match(g.note, /never observed/);
});

test('grading is idempotent: a graded promise is not re-graded', () => {
  const [p] = recordPromise([], promise());
  const once = gradePromise(p, { listed: 12.4, holdsOn: 8 });
  const twice = gradePromise(once, { listed: 99, holdsOn: 0 });
  assert.deepEqual(twice, once, 'the first verdict stands');
});

// ---------------------------------------------------------------------------
test('AN EMPTY SCOREBOARD IS NOT A PERFECT ONE', () => {
  // keptPct null, never 100 — the difference between "we have never been wrong"
  // and "we have never been checked".
  const s = scorePromises([]);
  assert.equal(s.keptPct, null);
  assert.equal(s.graded, 0);
  assert.equal(scoreSentence(s), 'No recommendations published yet');

  const pendingOnly = scorePromises(recordPromise([], promise()));
  assert.equal(pendingOnly.keptPct, null);
  assert.match(scoreSentence(pendingOnly), /none graded yet/);
});

test('the scoreboard counts only graded promises, and reports the ratio drift', () => {
  const rows = [
    { status: PROMISE.KEPT, observedRatio: 0.98 },
    { status: PROMISE.KEPT, observedRatio: 1.02 },
    { status: PROMISE.MISSED, observedRatio: 1.66 },
    { status: PROMISE.PENDING },
    { status: PROMISE.EXPIRED },
  ];
  const s = scorePromises(rows);
  assert.equal(s.total, 5);
  assert.equal(s.graded, 3);
  assert.equal(s.kept, 2);
  assert.equal(s.missed, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.expired, 1);
  assert.equal(s.keptPct, 66.7);
  assert.deepEqual(s.observedRatio, { n: 3, min: 0.98, max: 1.66, median: 1.02 });
  assert.match(scoreSentence(s), /2 of 3 recommendations delivered the position they promised \(66\.7%\)/);
});

test('never throws on junk', () => {
  assert.deepEqual(recordPromise(null, null), []);
  assert.equal(scorePromises(null).total, 0);
  assert.equal(typeof scoreSentence(null), 'string');
  assert.deepEqual(gradePromise(null, null), null);
  assert.equal(scorePromises([null, undefined, 3]).total, 1);
});
