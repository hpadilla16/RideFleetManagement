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
    lastOfferBySipp: new Map([['FJAR', { observedAt: new Date('2026-08-05T12:00:00Z'), price: 90.67, supplier: 'Routes Car & Truck Rentals' }]]),
  });
  assert.equal(out.length, 1, 'only the class nobody quoted');
  const [card] = out;
  assert.equal(card.sipp, 'FJAR');
  assert.equal(card.noComparables, true);
  assert.equal(card.vendorCount, 0);
  assert.equal(card.yourRate.daily, 115, 'your own price is still shown');
  assert.equal(card.yourRate.code, 'SJU_FJAR_DAILY');
  assert.equal(card.lastSeenAt.toISOString().slice(0, 10), '2026-08-05');
  assert.equal(card.lastOffer.price, 90.67, 'the rival price is the point of the card');
  assert.match(card.lastOffer.supplier, /Routes/);
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
    lastOfferBySipp: new Map(),
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

// ---------------------------------------------------------------------------
// The last rival offer (2026-09-10).
//
// Hector, after seeing the first version: a date alone still made him go dig.
// The card now names the rival and the price -- "Routes $90.67 - Aug 5" -- which
// is what the SJU Wrangler case actually needs: the market vanished from the
// feed on 2026-08-05 at $90.67 while IRC sits at $168.50 all-in.
// ---------------------------------------------------------------------------
test("the tenant's OWN brand is never quoted back to them as a rival", () => {
  // The newest row for the class may be the tenant's own listing. Showing it
  // would tell them the market matches their price, which is circular.
  const out = buildUncomparedCards({
    ownRatesBySipp: new Map([['FJAR', WRANGLER]]),
    quotedSipps: new Set(),
    lastOfferBySipp: new Map([['FJAR', null]]),
  });
  assert.equal(out.length, 1, 'the card still renders');
  assert.equal(out[0].lastOffer, null);
  assert.equal(out[0].lastSeenAt, null);
});

test('half a data point is no data point: a price without a date is dropped', () => {
  const [card] = buildUncomparedCards({
    ownRatesBySipp: new Map([['FJAR', WRANGLER]]),
    quotedSipps: new Set(),
    lastOfferBySipp: new Map([['FJAR', { price: 90.67, supplier: 'Routes' }]]),
  });
  assert.equal(card.lastOffer, null, 'a price nobody can date is a rumour');
});

test('a date without a usable price is dropped too', () => {
  for (const price of [null, undefined, '', 'abc', 0, -5]) {
    const [card] = buildUncomparedCards({
      ownRatesBySipp: new Map([['FJAR', WRANGLER]]),
      quotedSipps: new Set(),
      lastOfferBySipp: new Map([['FJAR', { observedAt: new Date('2026-08-05T12:00:00Z'), price, supplier: 'Routes' }]]),
    });
    assert.equal(card.lastOffer, null, `price ${JSON.stringify(price)} must not render`);
    assert.equal(card.lastSeenAt, null, 'and the date goes with it');
  }
});

test('a rival with no name still shows its price', () => {
  // Kayak leaves the supplier blank on some rows. The number is the useful half.
  const [card] = buildUncomparedCards({
    ownRatesBySipp: new Map([['FJAR', WRANGLER]]),
    quotedSipps: new Set(),
    lastOfferBySipp: new Map([['FJAR', { observedAt: new Date('2026-08-05T12:00:00Z'), price: 87 }]]),
  });
  assert.equal(card.lastOffer.price, 87);
  assert.equal(card.lastOffer.supplier, null);
});

test('lastSeenAt and lastOffer always agree — they come from one row', () => {
  const [card] = buildUncomparedCards({
    ownRatesBySipp: new Map([['FJAR', WRANGLER]]),
    quotedSipps: new Set(),
    lastOfferBySipp: new Map([['FJAR', { observedAt: '2026-08-05T14:30:00Z', price: '90.67', supplier: 'Routes' }]]),
  });
  assert.equal(card.lastOffer.observedAt.toISOString(), card.lastSeenAt.toISOString());
  assert.equal(card.lastOffer.price, 90.67, 'a decimal arriving as a string still ranks');
});

test('plain objects work as well as Maps and Sets', () => {
  const out = buildUncomparedCards({
    ownRatesBySipp: { FJAR: WRANGLER },
    quotedSipps: ['CCAR'],
    lastOfferBySipp: {},
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].sipp, 'FJAR');
});

test('never throws on junk', () => {
  for (const args of [{}, { ownRatesBySipp: null, quotedSipps: null }, { ownRatesBySipp: new Map([['', WRANGLER]]), quotedSipps: new Set() }]) {
    assert.ok(Array.isArray(buildUncomparedCards(args)));
  }
});
