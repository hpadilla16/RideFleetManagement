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
  const db = { integrationPricePolicy: { findUnique: async () => ({ priceSource: 'MARKET', ratePushEnabled: true, connectionType: 'AMADEUS' }) } };
  assert.deepEqual(await resolvePricePolicy(db, ARGS), {
    ratePushEnabled: true, priceSource: PRICE_SOURCES.MARKET, connectionType: 'AMADEUS', explicit: true,
  });
});

test('resolvePricePolicy: no row is the closed default — imports fine, publishes nothing', async () => {
  const db = { integrationPricePolicy: { findUnique: async () => null } };
  assert.deepEqual(await resolvePricePolicy(db, ARGS), {
    ratePushEnabled: false, priceSource: PRICE_SOURCES.MANUAL, connectionType: null, explicit: false,
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

// ---------------------------------------------------------------------------
// Per-integration connection type (2026-09-08). Hector: "para una cuenta que
// tiene multiples integraciones y no todas son las mismas, deberian poder
// configurarlo por sedes y por integracion".
// ---------------------------------------------------------------------------
const { normalizeConnectionType, makeConnectionRebaser } = await import('./price-source.js');

test('connection type: only the two real ones, everything else is "not declared"', () => {
  assert.equal(normalizeConnectionType('AMADEUS'), 'AMADEUS');
  assert.equal(normalizeConnectionType(' titanium '), 'TITANIUM');
  for (const bad of [null, undefined, '', 'SABRE', 'amadeus2', 0, {}]) {
    assert.equal(normalizeConnectionType(bad), null,
      `${JSON.stringify(bad)} must read as "inherit the sede", never as a connection`);
  }
});

function rebaserDb({ code = 'LAXA01', cfg } = {}) {
  return {
    location: { findUnique: async () => ({ code }) },
    marketPricingConfig: { findUnique: async () => cfg },
  };
}
const SEDE = { connectionType: 'TITANIUM', taxes: [{ pct: 11.5 }, { pct: 10.5 }], brokeragePct: 12 };
const ARGS2 = { tenantId: 't1', locationId: 'l1' };

test('rebaser: a declared DIFFERENT connection re-solves the base', async () => {
  const f = await makeConnectionRebaser(rebaserDb({ cfg: SEDE }), { ...ARGS2, connectionType: 'AMADEUS' });
  const out = f(40);
  assert.notEqual(out, 40, 'a different composition needs a different base for the same shelf price');
  assert.ok(out > 40);
});

test('rebaser: identity whenever nothing should change', async () => {
  // Not declared — the common case, and it must cost nothing.
  const a = await makeConnectionRebaser(rebaserDb({ cfg: SEDE }), ARGS2);
  assert.equal(a(40), 40);
  // Declared, but the same as the sede.
  const b = await makeConnectionRebaser(rebaserDb({ cfg: SEDE }), { ...ARGS2, connectionType: 'TITANIUM' });
  assert.equal(b(40), 40);
  // No pricing config to convert through.
  const c = await makeConnectionRebaser(rebaserDb({ cfg: null }), { ...ARGS2, connectionType: 'AMADEUS' });
  assert.equal(c(40), 40);
});

test('rebaser: a config that cannot be read leaves prices untouched, never invented', async () => {
  const boom = {
    location: { findUnique: async () => { throw new Error('down'); } },
    marketPricingConfig: { findUnique: async () => SEDE },
  };
  const f = await makeConnectionRebaser(boom, { ...ARGS2, connectionType: 'AMADEUS' });
  assert.equal(f(40), 40, 'an unconverted price is wrong by a margin; a fabricated one is worse');
  assert.equal((await makeConnectionRebaser(null, { ...ARGS2, connectionType: 'AMADEUS' }))(40), 40);
});

test('rebaser: an unsolvable value passes through rather than disappearing', async () => {
  const f = await makeConnectionRebaser(rebaserDb({ cfg: SEDE }), { ...ARGS2, connectionType: 'AMADEUS' });
  assert.equal(f(null), null, 'a class with no price stays a class with no price');
  assert.equal(f(0), 0, 'zero cannot be re-solved, and dropping it would unpublish the class');
});

// ---------------------------------------------------------------------------
// findPricingConfigForLocation (2026-09-09).
//
// MarketPricingConfig.locationCode is the AIRPORT code, not the sede code. For
// most sedes they are equal (IRC's sede at SJU is "SJU"), which is why keying
// on Location.code passed every test and still failed at LAX, where the sede is
// LAXA01 and the airport is LAX. It failed SILENTLY, because this path fails
// soft — the rebase would simply never have happened at the one sede it was
// built for.
// ---------------------------------------------------------------------------
const { findPricingConfigForLocation } = await import('./price-source.js');

function cfgDb({ code, rows = [] }) {
  const byKey = new Map(rows.map((r) => [String(r.locationCode).toUpperCase(), r]));
  return {
    location: { findUnique: async () => (code ? { code } : null) },
    marketPricingConfig: {
      findUnique: async ({ where }) => byKey.get(where.tenantId_locationCode.locationCode) || null,
      findMany: async () => rows,
    },
  };
}
const LAXCFG = { locationCode: 'LAX', connectionType: 'TITANIUM', taxes: [{ pct: 9.75 }], brokeragePct: 46.43 };
const SJUCFG = { locationCode: 'SJU', connectionType: 'TITANIUM', taxes: [{ pct: 11.5 }], brokeragePct: 20.1 };

test('config: the sede code IS the airport code — the common case still wins directly', async () => {
  const got = await findPricingConfigForLocation(cfgDb({ code: 'SJU', rows: [SJUCFG, LAXCFG] }), 't1', 'l1');
  assert.equal(got.locationCode, 'SJU');
});

test('config: LAXA01 resolves to the LAX airport row', async () => {
  const got = await findPricingConfigForLocation(cfgDb({ code: 'LAXA01', rows: [SJUCFG, LAXCFG] }), 't1', 'l1');
  assert.equal(got.locationCode, 'LAX', 'the sede LAXA01 sells at the airport LAX');
});

test('config: matching is case- and space-insensitive on the sede code', async () => {
  const got = await findPricingConfigForLocation(cfgDb({ code: ' laxa01 ', rows: [LAXCFG] }), 't1', 'l1');
  assert.equal(got.locationCode, 'LAX');
});

test('config: REFUSES when two airport codes both prefix the sede code', async () => {
  // Contrived, but the rule has to be stated: converting a price through the
  // wrong airport's taxes is worse than not converting it at all.
  const rows = [{ ...LAXCFG, locationCode: 'LAX' }, { ...LAXCFG, locationCode: 'LAXA' }];
  assert.equal(await findPricingConfigForLocation(cfgDb({ code: 'LAXA01', rows }), 't1', 'l1'), null);
});

test('config: a short key is never used as a prefix', async () => {
  const rows = [{ ...LAXCFG, locationCode: 'LA' }];
  assert.equal(await findPricingConfigForLocation(cfgDb({ code: 'LAXA01', rows }), 't1', 'l1'), null,
    'a two-letter key would match half the catalog');
});

test('config: no match, no sede, no client — null, never a throw', async () => {
  assert.equal(await findPricingConfigForLocation(cfgDb({ code: 'MIA', rows: [SJUCFG] }), 't1', 'l1'), null);
  assert.equal(await findPricingConfigForLocation(cfgDb({ code: null, rows: [SJUCFG] }), 't1', 'l1'), null);
  assert.equal(await findPricingConfigForLocation(null, 't1', 'l1'), null);
  assert.equal(await findPricingConfigForLocation({}, 't1', 'l1'), null);
  assert.equal(await findPricingConfigForLocation(cfgDb({ code: 'MIA' }), null, 'l1'), null);
});

test('config: a client WITHOUT findMany fails soft instead of throwing', async () => {
  // The trap that has bitten this codebase before: calling an absent delegate
  // method throws a TypeError synchronously, which `.catch` never sees.
  const db = {
    location: { findUnique: async () => ({ code: 'LAXA01' }) },
    marketPricingConfig: { findUnique: async () => null },
  };
  assert.equal(await findPricingConfigForLocation(db, 't1', 'l1'), null);
});

test('rebaser: LAX (sede LAXA01) now actually re-solves through the LAX config', async () => {
  const f = await makeConnectionRebaser(
    cfgDb({ code: 'LAXA01', rows: [LAXCFG] }),
    { tenantId: 't1', locationId: 'l1', connectionType: 'AMADEUS' },
  );
  assert.notEqual(f(40), 40, 'before this fix the config was unreachable and 40 came back unchanged');
});
