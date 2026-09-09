/**
 * Are we publishing what the strategy said? (2026-09-09)
 *
 * The load-bearing case is the SECOND direction. Hector asked for "somebody is
 * cheaper than us"; the LAX data says the live problem is the opposite one —
 * we sit far BELOW our own target and give money away. A one-directional check
 * would have called LAX healthy every day. Both axes are pinned here, including
 * a cell that fails neither and a cell that fails both.
 *
 * Pure: no DB, no env.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  evaluateCell, summarize, ownVendorKeys, isOwnOffer,
  AXIS_TARGET, AXIS_LADDER, DEFAULT_TOLERANCE,
} = await import('./price-self-check.js');

// ---------------------------------------------------------------------------
// Identifying our own listings
// ---------------------------------------------------------------------------
test('own keys: the market spelling rarely matches the franchise code', () => {
  const keys = ownVendorKeys(['MEXRENTACAR', 'Economy Rent a Car', 'Zezgo']);
  assert.equal(isOwnOffer('MEXRENTACAR', keys), true);
  assert.equal(isOwnOffer('Economy Rent A Car', keys), true, 'suffix and case are normalized away');
  assert.equal(isOwnOffer('Economy', keys), true, '"Economy Rent a Car" keys to ECONOMY');
  assert.equal(isOwnOffer('Zezgo', keys), true);
});

test('own keys: a competitor is never mistaken for us', () => {
  const keys = ownVendorKeys(['MEXRENTACAR', 'Economy Rent a Car']);
  for (const v of ['Ace', 'Hertz', 'Europcar', 'Midway', 'U-Save', 'NextCar']) {
    assert.equal(isOwnOffer(v, keys), false, `${v} is a competitor`);
  }
});

test('own keys: empty config matches nothing, and junk never throws', () => {
  const none = ownVendorKeys([]);
  assert.equal(isOwnOffer('Zezgo', none), false);
  assert.equal(isOwnOffer('', ownVendorKeys(['Zezgo'])), false);
  assert.equal(isOwnOffer(null, ownVendorKeys(['Zezgo'])), false);
  assert.equal(isOwnOffer('Zezgo', null), false);
  assert.deepEqual([...ownVendorKeys(null)], []);
  assert.deepEqual([...ownVendorKeys([null, '', '  '])], []);
});

// ---------------------------------------------------------------------------
// The two axes
// ---------------------------------------------------------------------------
test('THE LAX CASE: far below target, and still the cheapest — a real finding', () => {
  // Ace at 15.67, rule cheapest-$1 -> target 14.67, we publish 10.
  const c = evaluateCell({ ours: 10, target: 14.67, cheapestCompetitor: 15.67 });
  assert.equal(c.targetAxis, AXIS_TARGET.BELOW, 'we are giving away margin');
  assert.equal(c.ladderAxis, AXIS_LADDER.CHEAPEST, 'and nobody is undercutting us');
  assert.equal(c.deltaVsTarget, -4.67);
  // A one-directional "is anybody cheaper?" check reports this cell as fine.
  assert.notEqual(c.ladderAxis, AXIS_LADDER.UNDERCUT);
});

test("Hector's case: somebody slipped under us", () => {
  const c = evaluateCell({ ours: 20, target: 19.5, cheapestCompetitor: 18 });
  assert.equal(c.ladderAxis, AXIS_LADDER.UNDERCUT);
  assert.equal(c.deltaVsCheapest, 2);
});

test('a cell can fail BOTH axes at once', () => {
  // Dearer than intended AND beaten on the ladder.
  const c = evaluateCell({ ours: 30, target: 19.5, cheapestCompetitor: 18 });
  assert.equal(c.targetAxis, AXIS_TARGET.ABOVE);
  assert.equal(c.ladderAxis, AXIS_LADDER.UNDERCUT);
});

test('a healthy cell fails neither', () => {
  const c = evaluateCell({ ours: 14.67, target: 14.67, cheapestCompetitor: 15.67 });
  assert.equal(c.targetAxis, AXIS_TARGET.ON);
  assert.equal(c.ladderAxis, AXIS_LADDER.CHEAPEST);
});

test('tolerance: cents of drift are not a finding', () => {
  const c = evaluateCell({ ours: 14.9, target: 14.67, cheapestCompetitor: 15.67 });
  assert.equal(c.targetAxis, AXIS_TARGET.ON, `within ${DEFAULT_TOLERANCE}`);
  // And a competitor a few cents under us is not "undercut" either.
  assert.equal(evaluateCell({ ours: 15, cheapestCompetitor: 14.5 }).ladderAxis, AXIS_LADDER.CHEAPEST);
  // But past the band it is.
  assert.equal(evaluateCell({ ours: 15, cheapestCompetitor: 14 }).ladderAxis, AXIS_LADDER.UNDERCUT);
});

test('tolerance is configurable, and junk falls back to the default', () => {
  assert.equal(evaluateCell({ ours: 16, target: 14.67, tolerance: 5 }).targetAxis, AXIS_TARGET.ON);
  assert.equal(evaluateCell({ ours: 16, target: 14.67, tolerance: -1 }).targetAxis, AXIS_TARGET.ABOVE);
  assert.equal(evaluateCell({ ours: 16, target: 14.67, tolerance: 'x' }).targetAxis, AXIS_TARGET.ABOVE);
});

test('an exact tie on the ladder counts as cheapest, not undercut', () => {
  assert.equal(evaluateCell({ ours: 15, cheapestCompetitor: 15 }).ladderAxis, AXIS_LADDER.CHEAPEST);
});

test('NOT SEEING OURSELVES is reported, never treated as healthy', () => {
  const c = evaluateCell({ ours: null, target: 14.67, cheapestCompetitor: 15.67 });
  assert.equal(c.ourPriceSeen, false);
  assert.equal(c.targetAxis, AXIS_TARGET.UNKNOWN);
  assert.equal(c.ladderAxis, AXIS_LADDER.UNKNOWN);
  // Zero and negatives are absence, not a free rental.
  assert.equal(evaluateCell({ ours: 0, target: 10 }).ourPriceSeen, false);
  assert.equal(evaluateCell({ ours: -5, target: 10 }).ourPriceSeen, false);
});

test('a missing target or competitor leaves THAT axis unknown, not the other', () => {
  const noTarget = evaluateCell({ ours: 10, cheapestCompetitor: 15.67 });
  assert.equal(noTarget.targetAxis, AXIS_TARGET.UNKNOWN);
  assert.equal(noTarget.ladderAxis, AXIS_LADDER.CHEAPEST);

  const noRival = evaluateCell({ ours: 10, target: 14.67 });
  assert.equal(noRival.targetAxis, AXIS_TARGET.BELOW);
  assert.equal(noRival.ladderAxis, AXIS_LADDER.UNKNOWN);
});

test('evaluateCell never throws on junk', () => {
  for (const bad of [undefined, {}, { ours: 'x' }, { ours: NaN }, { ours: {} }]) {
    assert.equal(evaluateCell(bad).ourPriceSeen, false);
  }
});

// ---------------------------------------------------------------------------
// summarize — ranked by money, not by count
// ---------------------------------------------------------------------------
test('summary counts each axis and totals the money per day', () => {
  const cells = [
    evaluateCell({ ours: 10, target: 14.67, cheapestCompetitor: 15.67 }),  // below by 4.67
    evaluateCell({ ours: 7, target: 14.67, cheapestCompetitor: 15.67 }),   // below by 7.67
    evaluateCell({ ours: 20, target: 14.67, cheapestCompetitor: 18 }),     // above by 5.33 + undercut
    evaluateCell({ ours: 14.67, target: 14.67, cheapestCompetitor: 15.67 }), // fine
    evaluateCell({ ours: null, target: 14.67 }),                            // not listed
  ];
  const s = summarize(cells);
  assert.equal(s.cells, 5);
  assert.equal(s.seen, 4);
  assert.equal(s.unseen, 1);
  assert.equal(s.belowTarget, 2);
  assert.equal(s.aboveTarget, 1);
  assert.equal(s.onTarget, 1);
  assert.equal(s.undercut, 1);
  assert.equal(s.dollarsLeftPerDay, 12.34, '4.67 + 7.67');
  assert.equal(s.dollarsOverPerDay, 5.33);
});

test('summary leads with the costliest cell, not the most common one', () => {
  const s = summarize([
    evaluateCell({ ours: 14.4, target: 14.67 }),
    evaluateCell({ ours: 14.4, target: 14.67 }),
    evaluateCell({ ours: 7, target: 14.67 }),
  ]);
  assert.equal(s.worst.deltaVsTarget, -7.67);
});

test('summary of nothing is zeros, not a crash', () => {
  for (const bad of [[], null, undefined, [null, undefined]]) {
    const s = summarize(bad);
    assert.equal(s.seen, 0);
    assert.equal(s.worst, null);
    assert.equal(s.dollarsLeftPerDay, 0);
  }
});

// ---------------------------------------------------------------------------
// Thin ladders (2026-09-09) — found in the real LAX data, not imagined.
//
// Our Standard SUV sits at $14.67 and the rule reported a $77/day gap, because
// the ONLY competitor listing that class on those dates was Hertz at $93.
// Arithmetically right, operationally nonsense: LAX is bimodal and we compete
// in the independent tier. The finding is LABELLED, not suppressed — and it is
// kept out of the headline money total, which exists to be acted on.
// ---------------------------------------------------------------------------
const { DEFAULT_MIN_SAMPLE } = await import('./price-self-check.js');

test('a one-supplier ladder is flagged thin', () => {
  const c = evaluateCell({ ours: 14.67, target: 92, cheapestCompetitor: 93, rivalCount: 1 });
  assert.equal(c.thinLadder, true);
  assert.equal(c.targetAxis, AXIS_TARGET.BELOW, 'still reported — labelled, not hidden');
  assert.equal(c.deltaVsTarget, -77.33);
});

test('a deep ladder is not flagged', () => {
  const c = evaluateCell({ ours: 10, target: 14.67, cheapestCompetitor: 15.67, rivalCount: 9 });
  assert.equal(c.thinLadder, false);
});

test('the boundary is inclusive at the floor', () => {
  assert.equal(evaluateCell({ ours: 10, target: 14, rivalCount: DEFAULT_MIN_SAMPLE }).thinLadder, false);
  assert.equal(evaluateCell({ ours: 10, target: 14, rivalCount: DEFAULT_MIN_SAMPLE - 1 }).thinLadder, true);
});

test('an unknown depth is not flagged — callers that predate this field are unchanged', () => {
  assert.equal(evaluateCell({ ours: 10, target: 14.67 }).thinLadder, false);
  assert.equal(evaluateCell({ ours: 10, target: 14.67, rivalCount: 'x' }).rivalCount, null);
});

test('thin money is counted SEPARATELY so the headline total stays actionable', () => {
  const s = summarize([
    evaluateCell({ ours: 14.67, target: 92, cheapestCompetitor: 93, rivalCount: 1 }),   // -77.33 thin
    evaluateCell({ ours: 10, target: 14.67, cheapestCompetitor: 15.67, rivalCount: 8 }), // -4.67 solid
  ]);
  assert.equal(s.belowTarget, 2, 'both are real findings');
  assert.equal(s.thin, 1);
  assert.equal(s.dollarsLeftPerDay, 4.67, 'the $77 from a sample of one must not land here');
  assert.equal(s.dollarsLeftPerDayThin, 77.33);
});

test('the headline "worst" cell is never a thin-ladder one', () => {
  const s = summarize([
    evaluateCell({ ours: 14.67, target: 92, cheapestCompetitor: 93, rivalCount: 1 }),
    evaluateCell({ ours: 10, target: 14.67, cheapestCompetitor: 15.67, rivalCount: 8 }),
  ]);
  assert.equal(s.worst.deltaVsTarget, -4.67, 'lead with something somebody can act on');
});

test('a thin ladder still counts on the LADDER axis — being undercut is undercut', () => {
  const c = evaluateCell({ ours: 32, cheapestCompetitor: 27, rivalCount: 1 });
  assert.equal(c.ladderAxis, AXIS_LADDER.UNDERCUT, 'one rival under us is still a rival under us');
  assert.equal(summarize([c]).undercut, 1);
});
