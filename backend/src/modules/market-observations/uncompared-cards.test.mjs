/**
 * Cards for classes the market did not quote (2026-09-10).
 *
 * Hector, looking at the MI grid for SJU: "aun no veo los jeep aqui." He was
 * right, and the card was not hidden by a filter — it never existed. The grid
 * renders nine hardcoded classes plus whatever the summary returns, and the
 * summary only ever returned classes with competitor rows in the last 24h. IRC
 * prices FJAR (their Jeep Wrangler, $115/day, online at SJU) but no competitor
 * at SJU has listed an open-air 4x4 since 2026-08-05, so the class vanished —
 * indistinguishable, on screen, from a class nobody had configured.
 *
 * The load-bearing case is the first one: a priced class the market ignored
 * must still come back, flagged, with the date it was last seen. Silence and
 * absence are different problems and need different actions.
 *
 * Pure: no DB.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildUncomparedCards } = await import('./market-observations.service.js');

const WRANGLER = { id: 'r-fjar', rateCode: 'SJU_FJAR_DAILY', daily: 115 };
const COMPACT = { id: 'r-ccar', rateCode: 'SJU_CCAR_DAILY', daily: 14.14 };

test('THE ONE THAT MATTERS: a priced class the market ignored still gets a card', () => {
  const out = buildUncomparedCards({
    ownRatesBySipp: new Map([['FJAR', WRANGLER], ['CCAR', COMPACT]]),
    quotedSipps: new Set(['CCAR']),
    lastSeenBySipp: new Map([['FJAR', new Date('2026-08-05T12:00:00Z')]]),
  });
  assert.equal(out.length, 1, 'only the class nobody quoted');
  const [card] = out;
  assert.equal(card.sipp, 'FJAR');
  assert.equal(card.noComparables, true);
  assert.equal(card.vendorCount, 0);
  assert.equal(card.yourRate.daily, 115, 'your own price is still shown');
  assert.equal(card.yourRate.code, 'SJU_FJAR_DAILY');
  assert.equal(card.lastSeenAt.toISOString().slice(0, 10), '2026-08-05');
});

test('a class the market DID quote is never duplicated', () => {
  const out = buildUncomparedCards({
    ownRatesBySipp: new Map([['CCAR', COMPACT]]),
    quotedSipps: new Set(['CCAR']),
  });
  assert.deepEqual(out, [], 'the real card already covers it');
});

test('median/min/max stay NULL — a $0 would plot as the cheapest in the market', () => {
  // The regression this pins: filling zeros here would rank the tenant last
  // against a market of $0.00 and drag every chart to the floor.
  const [card] = buildUncomparedCards({
    ownRatesBySipp: new Map([['FJAR', WRANGLER]]),
    quotedSipps: new Set(),
  });
  assert.equal(card.median, null);
  assert.equal(card.min, null);
  assert.equal(card.max, null);
  assert.deepEqual(card.topVendors, []);
  assert.equal(card.yourRank, null, 'there is nothing to be ranked against');
});

test('never seen at all is reported as null, not as a fake date', () => {
  const [card] = buildUncomparedCards({
    ownRatesBySipp: new Map([['FVAR', { id: 'r-fvar', rateCode: 'SJU_FVAR_DAILY', daily: 250 }]]),
    quotedSipps: new Set(),
    lastSeenBySipp: new Map(),
  });
  assert.equal(card.lastSeenAt, null, 'the card says "never seen", it does not invent today');
});

test('with a tax config the card shows ALL-IN and keeps the base', () => {
  // Same rule as the real cards: comparing your BASE against competitor all-in
  // prices is what made LAX look cheap. 9.75% tax + 46.43% brokerage, Titanium.
  const cfg = { connectionType: 'TITANIUM', taxes: [{ name: 'LA tax', pct: 9.75 }], brokeragePct: 46.43 };
  const [card] = buildUncomparedCards({
    ownRatesBySipp: new Map([['FJAR', WRANGLER]]),
    quotedSipps: new Set(),
    pricingConfig: cfg,
  });
  assert.equal(card.yourRate.allIn, true);
  assert.equal(card.yourRate.base, 115, 'the uploaded number survives');
  assert.ok(card.yourRate.daily > 115, `all-in must exceed base, got ${card.yourRate.daily}`);
});

test('without a tax config the card shows the base and says so', () => {
  const [card] = buildUncomparedCards({
    ownRatesBySipp: new Map([['FJAR', WRANGLER]]),
    quotedSipps: new Set(),
    pricingConfig: null,
  });
  assert.equal(card.yourRate.allIn, false);
  assert.equal(card.yourRate.daily, 115);
});

test('a rate with an unusable price is NOT a card — it would render $NaN', () => {
  const out = buildUncomparedCards({
    ownRatesBySipp: new Map([
      ['FJAR', { id: 'x', rateCode: 'BROKEN', daily: null }],
      ['STAR', { id: 'y', rateCode: 'ALSO_BROKEN', daily: 'abc' }],
      ['MVAR', null],
    ]),
    quotedSipps: new Set(),
  });
  assert.deepEqual(out, []);
});

test('a $0 rate IS a card — zero is a real (and alarming) configured price', () => {
  // Distinct from the case above: null means unset, 0 means somebody typed it.
  // SJU_SPAR_DAILY carried twelve classes at $0.00 until 2026-09-10, and that
  // is exactly the state a revenue manager must be able to see.
  const [card] = buildUncomparedCards({
    ownRatesBySipp: new Map([['STAR', { id: 'z', rateCode: 'SJU_STAR_DAILY', daily: 0 }]]),
    quotedSipps: new Set(),
  });
  assert.equal(card.yourRate.daily, 0);
  assert.equal(card.yourRate.base, 0);
});

test('plain objects work as well as Maps and Sets', () => {
  const out = buildUncomparedCards({
    ownRatesBySipp: { FJAR: WRANGLER },
    quotedSipps: ['CCAR'],
    lastSeenBySipp: {},
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].sipp, 'FJAR');
});

test('never throws on junk', () => {
  for (const args of [{}, { ownRatesBySipp: null, quotedSipps: null }, { ownRatesBySipp: new Map([['', WRANGLER]]), quotedSipps: new Set() }]) {
    assert.ok(Array.isArray(buildUncomparedCards(args)));
  }
});
