/**
 * price-source — which prices a writeback is allowed to publish (2026-09-07).
 *
 * The load-bearing cases here are the two that decide real money:
 *   1. MANUAL must KEEP operator-authored overrides. They carry source = NULL,
 *      and the natural spelling of "not MARKET_A" in SQL drops NULL rows — so
 *      the obvious implementation publishes the base rate and silently throws
 *      away the surge somebody typed for a holiday weekend.
 *   2. An unreadable / absent policy must resolve to MANUAL, never MARKET.
 *      Failing open would let Market Intelligence write into a partner's live
 *      pricing system because a query hiccuped.
 *
 * No DB, no network: a hand-rolled fake db records the `where` it was handed so
 * the filter itself can be asserted, not just its effect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  PRICE_SOURCES,
  MARKET_AUTHOR,
  normalizePriceSource,
  resolvePriceSource,
  loadDailyOverrides,
  effectiveDaily,
} = await import('./price-source.js');

const FROM = '2026-09-10T00:00:00.000Z';
const TO = '2026-09-13T00:00:00.000Z';
const PAIRS = [{ rateId: 'r1', vehicleTypeId: 'v1' }];

/** A db whose rateDailyPrice.findMany applies the caller's own source filter. */
function fakeDb(rows, { capture = {} } = {}) {
  return {
    rateDailyPrice: {
      findMany: async (args) => {
        capture.where = args?.where;
        const clauses = args?.where?.AND || [];
        const sourceClause = clauses.find((c) => c.OR && c.OR.some((o) => 'source' in o));
        if (!sourceClause) return rows;
        // Mirror Postgres: the OR keeps NULL rows explicitly.
        return rows.filter((r) => r.source == null || r.source !== MARKET_AUTHOR);
      },
    },
  };
}

const ROWS = [
  { rateId: 'r1', vehicleTypeId: 'v1', date: new Date('2026-09-10T00:00:00Z'), daily: 120, source: null },
  { rateId: 'r1', vehicleTypeId: 'v1', date: new Date('2026-09-11T00:00:00Z'), daily: 88, source: MARKET_AUTHOR },
  { rateId: 'r1', vehicleTypeId: 'v1', date: new Date('2026-09-12T00:00:00Z'), daily: 200, source: 'OPERATOR' },
];

test('normalizePriceSource: anything unrecognised is MANUAL', () => {
  assert.equal(normalizePriceSource('MARKET'), PRICE_SOURCES.MARKET);
  assert.equal(normalizePriceSource('market'), PRICE_SOURCES.MARKET);
  assert.equal(normalizePriceSource('MANUAL'), PRICE_SOURCES.MANUAL);
  for (const bad of [undefined, null, '', 'MARKET_A', 'mi', 'TRUE', 0, {}]) {
    assert.equal(normalizePriceSource(bad), PRICE_SOURCES.MANUAL, `${JSON.stringify(bad)} must fall to MANUAL`);
  }
});

test('MANUAL keeps operator overrides (source NULL) and drops only MI rows', async () => {
  const capture = {};
  const out = await loadDailyOverrides(fakeDb(ROWS, { capture }), {
    pairs: PAIRS, from: FROM, to: TO, priceSource: PRICE_SOURCES.MANUAL,
  });
  const byDate = out.get('r1:v1');
  assert.ok(byDate, 'the pair must be present');
  assert.equal(byDate.get('2026-09-10'), 120, 'a NULL-source override is the operator’s and must survive');
  assert.equal(byDate.get('2026-09-12'), 200, 'a non-MI authored override must survive too');
  assert.equal(byDate.has('2026-09-11'), false, 'the MI row must not reach the portal');

  // The filter must be spelled so NULL is explicitly kept — asserting the
  // effect alone would pass against a `not` that silently drops NULLs, because
  // a naive fake would filter the same way the real query does not.
  const sourceClause = (capture.where?.AND || []).find((c) => c.OR && c.OR.some((o) => 'source' in o));
  assert.ok(sourceClause, 'MANUAL must add a source clause');
  assert.ok(
    sourceClause.OR.some((o) => o.source === null),
    'the clause must include `source: null` explicitly, not rely on `not` semantics',
  );
});

test('MARKET publishes every override, MI included, and adds no source filter', async () => {
  const capture = {};
  const out = await loadDailyOverrides(fakeDb(ROWS, { capture }), {
    pairs: PAIRS, from: FROM, to: TO, priceSource: PRICE_SOURCES.MARKET,
  });
  const byDate = out.get('r1:v1');
  assert.equal(byDate.get('2026-09-11'), 88, 'MI’s price is exactly what MARKET means');
  assert.equal(byDate.size, 3);
  const sourceClause = (capture.where?.AND || []).find((c) => c.OR && c.OR.some((o) => 'source' in o));
  assert.equal(sourceClause, undefined, 'MARKET must not filter by author at all');
});

test('an absent priceSource behaves as MANUAL', async () => {
  const out = await loadDailyOverrides(fakeDb(ROWS), { pairs: PAIRS, from: FROM, to: TO });
  assert.equal(out.get('r1:v1').has('2026-09-11'), false);
});

test('non-positive and unparseable dailies are never published', async () => {
  const junk = [
    { rateId: 'r1', vehicleTypeId: 'v1', date: new Date('2026-09-10T00:00:00Z'), daily: 0, source: null },
    { rateId: 'r1', vehicleTypeId: 'v1', date: new Date('2026-09-11T00:00:00Z'), daily: -5, source: null },
    { rateId: 'r1', vehicleTypeId: 'v1', date: new Date('2026-09-12T00:00:00Z'), daily: 'abc', source: null },
  ];
  const out = await loadDailyOverrides(fakeDb(junk), { pairs: PAIRS, from: FROM, to: TO });
  assert.equal(out.size, 0, 'a zero or broken override must fall back to the base, not publish 0');
});

test('no pairs / no window / no db is an empty map, never a throw', async () => {
  assert.equal((await loadDailyOverrides(fakeDb(ROWS), { pairs: [], from: FROM, to: TO })).size, 0);
  assert.equal((await loadDailyOverrides(fakeDb(ROWS), { pairs: PAIRS })).size, 0);
  assert.equal((await loadDailyOverrides(null, { pairs: PAIRS, from: FROM, to: TO })).size, 0);
});

test('a query failure is an empty map — the base rate still publishes', async () => {
  const exploding = { rateDailyPrice: { findMany: async () => { throw new Error('pool timeout'); } } };
  const out = await loadDailyOverrides(exploding, { pairs: PAIRS, from: FROM, to: TO });
  assert.equal(out.size, 0);
});

test('resolvePriceSource: the stored choice, and MANUAL whenever it cannot be read', async () => {
  const db = (row) => ({ integrationPricePolicy: { findUnique: async () => row } });
  assert.equal(
    await resolvePriceSource(db({ priceSource: 'MARKET' }), { tenantId: 't', locationId: 'l', provider: 'MEX' }),
    PRICE_SOURCES.MARKET,
  );
  assert.equal(
    await resolvePriceSource(db(null), { tenantId: 't', locationId: 'l', provider: 'MEX' }),
    PRICE_SOURCES.MANUAL,
    'no row is the MANUAL default, not an error',
  );
  const exploding = { integrationPricePolicy: { findUnique: async () => { throw new Error('down'); } } };
  assert.equal(
    await resolvePriceSource(exploding, { tenantId: 't', locationId: 'l', provider: 'MEX' }),
    PRICE_SOURCES.MANUAL,
    'a failed read must never fail OPEN into MARKET',
  );
  for (const missing of [{}, { tenantId: 't' }, { tenantId: 't', locationId: 'l' }]) {
    assert.equal(await resolvePriceSource(db({ priceSource: 'MARKET' }), missing), PRICE_SOURCES.MANUAL);
  }
});

test('resolvePriceSource asks for the exact composite key', async () => {
  let seen = null;
  const db = { integrationPricePolicy: { findUnique: async (args) => { seen = args; return null; } } };
  await resolvePriceSource(db, { tenantId: 't1', locationId: 'l1', provider: 'economy' });
  assert.deepEqual(seen.where.tenantId_locationId_provider, {
    tenantId: 't1', locationId: 'l1', provider: 'ECONOMY',
  }, 'the provider must be upper-cased to match how it is stored');
});

test('effectiveDaily: the override wins, the base backs it, nothing invents a price', () => {
  const overrides = new Map([['r1:v1', new Map([['2026-09-10', 120]])]]);
  assert.equal(effectiveDaily(overrides, 'r1:v1', '2026-09-10', 90), 120);
  assert.equal(effectiveDaily(overrides, 'r1:v1', '2026-09-11', 90), 90);
  assert.equal(effectiveDaily(overrides, 'nope:x', '2026-09-10', 90), 90);
  assert.equal(effectiveDaily(overrides, 'r1:v1', '2026-09-11', 0), null);
  assert.equal(effectiveDaily(overrides, 'r1:v1', '2026-09-11', null), null);
  assert.equal(effectiveDaily(null, 'r1:v1', '2026-09-11', 90), 90);
});

// ---------------------------------------------------------------------------
// The per-sede rate-push switch (2026-09-07). Hector: "que todas las
// integraciones tengan un switch para prender o apagar rate pushing para asi no
// tener que apagar una integracion completa por lo del rate".
//
// It must FAIL CLOSED on every path. A sede that cannot be read, or has never
// been configured, publishes nothing — the opposite would mean a query hiccup
// writes prices into a partner's live system.
// ---------------------------------------------------------------------------
const { resolvePricePolicy } = await import('./price-source.js');

const ARGS = { tenantId: 't', locationId: 'l', provider: 'MEX' };

test('resolvePricePolicy: a stored row is read verbatim', async () => {
  const db = { integrationPricePolicy: { findUnique: async () => ({ priceSource: 'MARKET', ratePushEnabled: true }) } };
  assert.deepEqual(await resolvePricePolicy(db, ARGS), {
    ratePushEnabled: true, priceSource: PRICE_SOURCES.MARKET, explicit: true,
  });
});

test('resolvePricePolicy: no row is the closed default — imports fine, publishes nothing', async () => {
  const db = { integrationPricePolicy: { findUnique: async () => null } };
  assert.deepEqual(await resolvePricePolicy(db, ARGS), {
    ratePushEnabled: false, priceSource: PRICE_SOURCES.MANUAL, explicit: false,
  });
});

test('resolvePricePolicy: an unreadable policy never fails open', async () => {
  const exploding = { integrationPricePolicy: { findUnique: async () => { throw new Error('pool timeout'); } } };
  const out = await resolvePricePolicy(exploding, ARGS);
  assert.equal(out.ratePushEnabled, false, 'a database hiccup must not authorise a write');
  assert.equal(out.priceSource, PRICE_SOURCES.MANUAL);

  for (const missing of [{}, { tenantId: 't' }, { tenantId: 't', locationId: 'l' }]) {
    assert.equal((await resolvePricePolicy(exploding, missing)).ratePushEnabled, false);
  }
  assert.equal((await resolvePricePolicy(null, ARGS)).ratePushEnabled, false);
});

test('resolvePricePolicy: only a real true enables the push', async () => {
  // A string, a 1 or a null out of the driver must not read as permission.
  for (const raw of ['true', 1, 'yes', null, undefined, {}]) {
    const db = { integrationPricePolicy: { findUnique: async () => ({ priceSource: 'MARKET', ratePushEnabled: raw }) } };
    assert.equal(
      (await resolvePricePolicy(db, ARGS)).ratePushEnabled, false,
      `${JSON.stringify(raw)} is not a boolean true`,
    );
  }
});

test('resolvePriceSource still answers the source half alone', async () => {
  const db = { integrationPricePolicy: { findUnique: async () => ({ priceSource: 'MARKET', ratePushEnabled: false }) } };
  assert.equal(await resolvePriceSource(db, ARGS), PRICE_SOURCES.MARKET,
    'a paused sede still has a source — the screen shows what it WOULD publish');
});
