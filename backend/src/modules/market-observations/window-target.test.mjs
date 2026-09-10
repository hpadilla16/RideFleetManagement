/**
 * "Para este pool de catorce dias, si tu quieres ser el segundo mas barato CADA
 * DIA, este es el precio que tienes que poner" (2026-09-10, Hector).
 *
 * Two tests carry this file. The first: when no single price can hold the slot
 * on every date, say so and give the coverage — the real SJU numbers had CCAR
 * needing to be above $19.12 on one date and below $18.30 on another. The
 * second: when the floor moves the price, report what the CLAMPED price
 * achieves, not what the recommendation would have. That one shipped broken —
 * CCAR held 8 of 12 dates at $12.48 and 1 of 12 once clamped to its $14.14
 * floor, with nothing anywhere saying so.
 *
 * Pure: no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { recommendBaseForTarget, verifyPositionAt, positionOn, targetSentence, ANSWER } =
  await import('./window-target.js');

/** Ladders are what the OTA LISTS, ascending, one entry per pickup date. */
const L = (...prices) => prices.sort((a, b) => a - b).map((price) => ({ price }));

// ---------------------------------------------------------------------------
test('FEASIBLE: one price holds the slot on every date, and it is verified there', () => {
  // Rivals at 20/30 and 22/33 — to be 2nd we must sit between 20 and 22 on the
  // first date and between 22 and 33 on the second. Intersection: (22, 30) ->
  // wait: lower = max(20,22) = 22, upper = min(30,33) = 30. Any price in
  // (22,30) is 2nd on both.
  const rec = recommendBaseForTarget({
    laddersByDate: new Map([['2026-09-11', L(20, 30)], ['2026-09-12', L(22, 33)]]),
    targetN: 2,
  });
  assert.equal(rec.answer, ANSWER.FEASIBLE);
  assert.equal(rec.listedTarget, 29.99, 'the highest price that still holds it');
  assert.equal(rec.base, 29.99, 'ratio 1 assumed, so base == listed');
  assert.equal(rec.holdsOn, 2);
  assert.equal(rec.usableDates, 2);
  assert.deepEqual(rec.band, { lower: 22, upper: 30 });
});

test('THE REAL CASE — PARTIAL: no price is 2nd everywhere, so report coverage', () => {
  // One date demands > $19.12, another demands < $18.30. No intersection.
  const rec = recommendBaseForTarget({
    laddersByDate: new Map([
      ['2026-09-11', L(19.12, 25.00)],   // to be 2nd here we must exceed 19.12
      ['2026-09-12', L(15.00, 18.30)],   // and here we must stay under 18.30
      ['2026-09-13', L(15.00, 18.30)],
    ]),
    targetN: 2,
  });
  assert.equal(rec.answer, ANSWER.PARTIAL);
  assert.ok(rec.holdsOn > 0 && rec.holdsOn < rec.usableDates, `held ${rec.holdsOn} of ${rec.usableDates}`);
  // Whatever it recommends, the count it reports must be the count it achieves.
  const v = verifyPositionAt({
    laddersByDate: new Map([
      ['2026-09-11', L(19.12, 25.00)], ['2026-09-12', L(15.00, 18.30)], ['2026-09-13', L(15.00, 18.30)],
    ]),
    listedPrice: rec.listedAfterClamp,
    targetN: 2,
  });
  assert.equal(v.exact, rec.holdsOn, 'the promise IS the measurement');
  assert.match(targetSentence(rec), /No single price is 2nd cheapest on every date/);
});

test('NOT_ANSWERABLE: no date has N rivals, so no number is offered', () => {
  // Ten of fourteen SJU classes were in this state for target #2.
  const rec = recommendBaseForTarget({
    laddersByDate: new Map([['2026-09-11', L(20)], ['2026-09-12', L(22)]]),
    targetN: 2,
  });
  assert.equal(rec.answer, ANSWER.NOT_ANSWERABLE);
  assert.equal(rec.base, null, 'no price is invented');
  assert.equal(rec.usableDates, 0);
  assert.equal(rec.datesInPool, 2);
  assert.match(targetSentence(rec), /Cannot say/);
});

test('a date with too few rivals is excluded, not counted as a miss', () => {
  const rec = recommendBaseForTarget({
    laddersByDate: new Map([
      ['2026-09-11', L(20, 30)], ['2026-09-12', L(22, 33)],
      ['2026-09-13', L(18)],                   // only one rival: cannot host a #2
    ]),
    targetN: 2,
  });
  assert.equal(rec.usableDates, 2, 'the thin date is out of the denominator');
  assert.equal(rec.datesInPool, 3, 'but the pool size is still reported');
  assert.equal(rec.holdsOn, 2);
});

// ---------------------------------------------------------------------------
// The clamp — the defect this module exists to close
// ---------------------------------------------------------------------------
test('THE CLAMP TELLS THE TRUTH: the position is recomputed at the clamped price', () => {
  // The measured CCAR shape: the recommendation lands under the floor, and the
  // floor is well above every rival, so the clamped price wins nothing.
  const ladders = new Map([
    ['2026-09-11', L(15.00, 15.67)], ['2026-09-12', L(15.00, 15.67)], ['2026-09-13', L(15.00, 15.67)],
  ]);
  const rec = recommendBaseForTarget({ laddersByDate: ladders, targetN: 2, floor: 20 });
  assert.equal(rec.clampedTo, 'floor');
  assert.equal(rec.base, 20);
  assert.equal(rec.wantedBase, 15.66, 'what it wanted, kept for the record');
  assert.equal(rec.wantedHoldsOn, 3, 'and what THAT would have held');
  assert.equal(rec.holdsOn, 0, 'the clamped price holds nothing — reported honestly');
  assert.equal(rec.clampChangedOutcome, true);
  assert.match(targetSentence(rec), /WARNING: your floor moved it from \$15\.66, which would have held 3 of 3/);
});

test('a clamp that does NOT change the outcome is not shouted about', () => {
  // Clamping matters when it costs dates, not merely when it moves a decimal.
  // Band is (31, 36), so the recommendation is $35.99 and a $36 floor lifts it
  // by a cent — still under both second rungs, so nothing was lost.
  const ladders = new Map([['2026-09-11', L(30, 36)], ['2026-09-12', L(31, 37)]]);
  const rec = recommendBaseForTarget({ laddersByDate: ladders, targetN: 2, floor: 36 });
  assert.equal(rec.clampedTo, 'floor');
  assert.equal(rec.clampChangedOutcome, false, 'still 2nd on both dates');
  assert.equal(rec.holdsOn, 2);
  assert.equal(/WARNING/.test(targetSentence(rec)), false);
});

test('the ceiling clamps too, and is reported the same way', () => {
  const ladders = new Map([['2026-09-11', L(80, 200)], ['2026-09-12', L(90, 210)]]);
  const rec = recommendBaseForTarget({ laddersByDate: ladders, targetN: 2, ceiling: 100 });
  assert.equal(rec.clampedTo, 'ceiling');
  assert.equal(rec.base, 100);
  assert.equal(rec.holdsOn, 2, 'still 2nd — the ceiling did not cost anything here');
});

// ---------------------------------------------------------------------------
// The ratio: a BASE is recommended, converted with the MEASURED ratio
// ---------------------------------------------------------------------------
test('the base is the listed target divided by the measured ratio', () => {
  // IRC CCAR measured 0.919-1.037; using the 1.4652 tax gross-up here would
  // recommend a base about a third too low.
  const ladders = new Map([['2026-09-11', L(20)], ['2026-09-12', L(20)]]);
  const rec = recommendBaseForTarget({ laddersByDate: ladders, targetN: 1, ratio: 0.95 });
  assert.equal(rec.listedTarget, 19.99);
  assert.equal(rec.base, 21.04, '19.99 / 0.95');
  assert.equal(rec.ratioUsed, 0.95);
  assert.equal(rec.ratioAssumed, false);
  assert.equal(rec.listedAfterClamp, 19.99, 'and it lists back at the target');
  assert.equal(rec.holdsOn, 2);
});

test('no measured ratio assumes 1 and SAYS so in the sentence', () => {
  const rec = recommendBaseForTarget({ laddersByDate: new Map([['2026-09-11', L(20)]]), targetN: 1 });
  assert.equal(rec.ratioAssumed, true);
  assert.equal(rec.ratioUsed, 1);
  assert.match(targetSentence(rec), /assumes the OTA lists your base unchanged/);
});

test('a junk ratio falls back to 1 rather than producing a nonsense base', () => {
  for (const bad of [0, -1, 'abc', null, Infinity]) {
    const rec = recommendBaseForTarget({ laddersByDate: new Map([['2026-09-11', L(20)]]), targetN: 1, ratio: bad });
    assert.equal(rec.ratioUsed, 1, `ratio ${JSON.stringify(bad)}`);
    assert.equal(rec.ratioAssumed, true);
  }
});

// ---------------------------------------------------------------------------
test('the padding rides on the LISTED target, where the tenant means it', () => {
  // "Cheapest minus a dollar" is a statement about the shelf price, not about
  // the base — and -2% of a listed $20 is not -2% of a grossed-up anything.
  const ladders = new Map([['2026-09-11', L(20)], ['2026-09-12', L(20)]]);
  const rec = recommendBaseForTarget({ laddersByDate: ladders, targetN: 1, paddingPct: -2 });
  assert.equal(rec.listedTarget, 19.59, '(20 - 0.01) x 0.98');
  assert.equal(rec.holdsOn, 2, 'still cheapest, by more');
});

test('being cheapest is one constraint, so it is feasible far more often', () => {
  // The measured asymmetry: target #1 held on 100% of dates in every answerable
  // SJU class, while #2 managed 31-67%. Being under the minimum is a single
  // condition; sitting BETWEEN two rivals is two that fight across dates.
  const ladders = new Map([
    ['2026-09-11', L(15, 40)], ['2026-09-12', L(16, 18)], ['2026-09-13', L(30, 31)],
  ]);
  const first = recommendBaseForTarget({ laddersByDate: ladders, targetN: 1 });
  const second = recommendBaseForTarget({ laddersByDate: ladders, targetN: 2 });
  assert.equal(first.answer, ANSWER.FEASIBLE);
  assert.equal(first.holdsOn, 3);
  assert.equal(second.answer, ANSWER.PARTIAL);
  assert.ok(second.holdsOn < 3);
});

test('positionOn treats a tie as not-an-undercut', () => {
  assert.equal(positionOn(L(10, 20), 10), 1, 'equal price does not push us down');
  assert.equal(positionOn(L(10, 20), 10.01), 2);
});

test('never throws on junk', () => {
  for (const args of [undefined, {}, { laddersByDate: null }, { laddersByDate: new Map([['x', null]]), targetN: 'abc' }]) {
    const rec = recommendBaseForTarget(args);
    assert.ok(Object.values(ANSWER).includes(rec.answer));
    assert.equal(typeof targetSentence(rec), 'string');
  }
  assert.equal(targetSentence(null), null);
});

// ---------------------------------------------------------------------------
// What the tenant GETS vs what the market allowed (2026-09-10, found by running
// this against the real pool: FFAR reported "2nd cheapest on all 3 dates" while
// the floor had already pushed the price to where it held ZERO).
// ---------------------------------------------------------------------------
test('BLOCKED: the market allowed it, your own floor does not — and the sentence says which', () => {
  const ladders = new Map([
    ['2026-09-11', L(15.00, 15.67)], ['2026-09-12', L(15.00, 15.67)], ['2026-09-13', L(15.00, 15.67)],
  ]);
  const rec = recommendBaseForTarget({ laddersByDate: ladders, targetN: 2, floor: 40 });
  assert.equal(rec.marketAnswer, ANSWER.FEASIBLE, 'the market had room');
  assert.equal(rec.answer, ANSWER.BLOCKED, 'the tenant does not get it');
  assert.equal(rec.holdsOn, 0);
  const s = targetSentence(rec);
  assert.match(s, /Your floor blocks this/);
  assert.equal(/on all 3 dates/.test(s), false, 'it must NOT claim the market answer');
});

test('a FEASIBLE sentence only claims dates the recommended price actually holds', () => {
  const ladders = new Map([['2026-09-11', L(20, 30)], ['2026-09-12', L(22, 33)]]);
  const rec = recommendBaseForTarget({ laddersByDate: ladders, targetN: 2 });
  assert.equal(rec.answer, ANSWER.FEASIBLE);
  assert.equal(rec.holdsOn, rec.usableDates, 'the claim and the count are the same number');
  assert.match(targetSentence(rec), /on all 2 dates/);
});

test('ordinals: 1st, 2nd, 3rd, 4th, 11th — never "3th"', () => {
  const ladders = new Map([['2026-09-11', L(10, 20, 30, 40)]]);
  const say = (n) => targetSentence(recommendBaseForTarget({ laddersByDate: ladders, targetN: n }));
  assert.match(say(2), /2nd cheapest/);
  assert.match(say(3), /3rd cheapest/);
  assert.match(say(4), /4th cheapest/);
  assert.equal(/3th|2th|1th/.test(say(3)), false);
});
