import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { evaluateRule, runPricingEngine } from './pricing-suggestion-engine.service.js';
import { settingsService } from '../settings/settings.service.js';

// Minimum-sample guard (2026-09-02, mechanism only). One competitor offer used
// to be enough to move a live price (the only volume check was obs.length ===
// 0). The guard adds a per-tenant floor on DISTINCT agencies (vendors) in the
// cell — default 1, i.e. EXACTLY the old behavior until Hector raises it.
// Below the floor the rule is skipped with reason 'below_min_sample', the same
// idiom as 'no_recent_observations'.

// ── prisma mock (same monkey-patch spirit as pricing-engine-retire.test.mjs) ─

function installMock() {
  for (const k of ['pricingRule', 'pricingSuggestion', 'rate', 'rateItem', 'marketScrapeProfile', 'marketPricingConfig', 'marketObservation', 'rateOffer', 'appSetting']) {
    if (!prisma[k]) prisma[k] = {};
  }
  const state = {
    offers: [],
    rules: [],
    appSettings: new Map(), // key → value(JSON string)
    suggestionCreates: [],
    rateUpdates: [],
  };
  const orig = {};
  const set = (path, fn) => { const [a, b] = path.split('.'); orig[path] = prisma[a][b]; prisma[a][b] = fn; };
  set('rateOffer.findMany', async () => state.offers);
  set('marketObservation.findMany', async () => []);
  set('pricingSuggestion.create', async ({ data }) => { state.suggestionCreates.push(data); return { id: 'sg', ...data }; });
  set('pricingSuggestion.updateMany', async () => ({ count: 0 }));
  set('pricingRule.findMany', async () => state.rules);
  set('rate.update', async (args) => { state.rateUpdates.push(args); return { id: args.where.id }; });
  set('rateItem.updateMany', async () => ({ count: 1 }));
  set('marketScrapeProfile.findMany', async () => []);
  set('marketPricingConfig.findUnique', async () => null);
  set('appSetting.findUnique', async ({ where }) => {
    const value = state.appSettings.get(where.key);
    return value === undefined ? null : { key: where.key, value };
  });
  set('appSetting.upsert', async ({ where, create, update }) => {
    const value = state.appSettings.has(where.key) ? update.value : create.value;
    state.appSettings.set(where.key, value);
    return { key: where.key, value };
  });
  const origTx = prisma.$transaction;
  prisma.$transaction = async (arr) => Promise.all(arr);
  return {
    state,
    restore() {
      for (const [path, fn] of Object.entries(orig)) { const [a, b] = path.split('.'); prisma[a][b] = fn; }
      prisma.$transaction = origTx;
    },
  };
}

// A rule that reaches the sampling code: explicit sipp + location, non-AUTO
// mode so the PENDING path (a pricingSuggestion.create, no Rate write) runs.
function makeRule(over = {}) {
  return {
    id: 'rule-1', rateId: 'rate-1', tenantId: 'tenant-1',
    strategy: 'NTH_CHEAPEST', targetN: 1, mode: 'SUGGEST',
    paddingPct: 0, floorPrice: 1, ceilingPrice: 500, autoMaxDeltaPct: null,
    active: true, sipp: 'ECAR',
    rate: { id: 'rate-1', tenantId: 'tenant-1', rateCode: 'ECON', daily: 50, locationId: 'loc-1', location: { id: 'loc-1', code: 'SJU' } },
    ...over,
  };
}

// EXPEDIA_DIRECT so the row passes the purpose:'pricing' all-in allowlist
// with no env flag involved.
function makeOffer(over = {}) {
  return {
    id: `o-${Math.random().toString(36).slice(2, 8)}`,
    runId: 'run-1', profileId: 'profile-1',
    observedAt: new Date(),
    source: 'EXPEDIA_DIRECT', provider: 'Expedia', supplier: 'Hertz',
    pickupDate: new Date('2026-09-10'), returnDate: new Date('2026-09-13'), lorDays: 3,
    sipp: 'ECAR', rawCategory: 'Economy',
    dailyPrice: 40, totalPrice: 120, effectiveDailyPrice: 40,
    status: 'FOUND',
    ...over,
  };
}

// ── settingsService.getMarketPricingSampleConfig / update… ──────────────────

describe('marketPricingConfig.minSampleVendors setting', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('defaults to 3 when no AppSetting row exists', async () => {
    // Raised from 1 on 2026-09-11. At 1 a single agency having a quiet night
    // decided a live rate; three is the smallest sample where the 2nd-cheapest
    // target these rules use has anything under it.
    const cfg = await settingsService.getMarketPricingSampleConfig({ tenantId: 'tenant-1' });
    assert.deepEqual(cfg, { minSampleVendors: 3 });
  });

  it('falls back to the default on junk values (0, negative, NaN, strings)', async () => {
    for (const junk of [0, -3, 'nope', null, {}]) {
      mock.state.appSettings.set('tenant:tenant-1:marketPricingConfig', JSON.stringify({ minSampleVendors: junk }));
      const cfg = await settingsService.getMarketPricingSampleConfig({ tenantId: 'tenant-1' });
      assert.equal(cfg.minSampleVendors, 3, `junk ${JSON.stringify(junk)} must fall back to the default`);
    }
  });

  it('update floors to an integer, is tenant-scoped, and round-trips', async () => {
    // 5.9 rather than 3.9 on purpose: 3 is now the DEFAULT, so a stored 3
    // would be indistinguishable from no row at all and the scoping assertion
    // below would pass without proving anything.
    const out = await settingsService.updateMarketPricingSampleConfig({ minSampleVendors: 5.9 }, { tenantId: 'tenant-1' });
    assert.deepEqual(out, { minSampleVendors: 5 });
    assert.ok(mock.state.appSettings.has('tenant:tenant-1:marketPricingConfig'), 'stored under the tenant-scoped key');
    const cfg = await settingsService.getMarketPricingSampleConfig({ tenantId: 'tenant-1' });
    assert.equal(cfg.minSampleVendors, 5);
    // Another tenant is untouched — it still reads the default, not tenant-1's 5.
    const other = await settingsService.getMarketPricingSampleConfig({ tenantId: 'tenant-2' });
    assert.equal(other.minSampleVendors, 3);
  });

  it('update ignores invalid input and preserves unrelated keys in the JSON', async () => {
    mock.state.appSettings.set('tenant:tenant-1:marketPricingConfig', JSON.stringify({ minSampleVendors: 4, futureKnob: 'x' }));
    const out = await settingsService.updateMarketPricingSampleConfig({ minSampleVendors: 0 }, { tenantId: 'tenant-1' });
    assert.equal(out.minSampleVendors, 4, 'invalid 0 must not overwrite the stored floor');
    const raw = JSON.parse(mock.state.appSettings.get('tenant:tenant-1:marketPricingConfig'));
    assert.equal(raw.futureKnob, 'x', 'sibling keys survive the update');
  });
});

// ── evaluateRule guard behavior ──────────────────────────────────────────────

describe('evaluateRule — minimum-sample guard', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('DEFAULT floor 3: a single offer is NOT enough to move a live price', async () => {
    // The point of the 2026-09-11 raise. One agency is an anecdote, and the
    // rule cannot tell an anecdote from a market.
    mock.state.offers = [makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 40 })];
    const result = await evaluateRule(makeRule());
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'below_min_sample');
    assert.equal(mock.state.suggestionCreates.length, 0, 'nothing written');
  });

  it('DEFAULT floor 3: three distinct agencies DO produce a suggestion', async () => {
    mock.state.offers = [
      makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 40 }),
      makeOffer({ supplier: 'Avis', effectiveDailyPrice: 44 }),
      makeOffer({ supplier: 'Sixt', effectiveDailyPrice: 48 }),
    ];
    const result = await evaluateRule(makeRule());
    assert.equal(result.skipped, false);
    assert.equal(mock.state.suggestionCreates.length, 1);
  });

  it('floor 2 with only 1 distinct vendor → skipped: below_min_sample, nothing written', async () => {
    mock.state.offers = [makeOffer({ supplier: 'Hertz' })];
    const result = await evaluateRule(makeRule(), {
      getMinSampleConfig: async () => ({ minSampleVendors: 2 }),
    });
    assert.deepEqual(result, { skipped: true, reason: 'below_min_sample' });
    assert.equal(mock.state.suggestionCreates.length, 0, 'no suggestion row on a thin market');
    assert.equal(mock.state.rateUpdates.length, 0, 'no price write on a thin market');
  });

  it('counts DISTINCT agencies, not rows: 3 rows from one vendor is still 1 vendor', async () => {
    mock.state.offers = [
      makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 40 }),
      makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 42, pickupDate: new Date('2026-09-11') }),
      makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 44, pickupDate: new Date('2026-09-12') }),
    ];
    const result = await evaluateRule(makeRule(), {
      getMinSampleConfig: async () => ({ minSampleVendors: 2 }),
    });
    assert.deepEqual(result, { skipped: true, reason: 'below_min_sample' });
  });

  it('floor 2 with 2 distinct vendors → proceeds and prices off the ladder', async () => {
    mock.state.offers = [
      makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 40 }),
      makeOffer({ supplier: 'Avis', effectiveDailyPrice: 45 }),
    ];
    const result = await evaluateRule(makeRule(), {
      getMinSampleConfig: async () => ({ minSampleVendors: 2 }),
    });
    assert.equal(result.skipped, false);
    assert.equal(result.suggestedPrice, 40, 'NTH_CHEAPEST n=1 → cheapest vendor');
  });

  it('vendors dropped by the pricing all-in gate do NOT count toward the floor', async () => {
    // Two vendors on paper, but one arrives via unconfirmed KAYAK teaser rows —
    // the same rows the pricing math itself will not see.
    delete process.env.KAYAK_EFFECTIVE_IS_ALL_IN;
    mock.state.offers = [
      makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 40 }),
      makeOffer({ supplier: 'Avis', source: 'KAYAK', provider: 'Priceline', effectiveDailyPrice: 30 }),
    ];
    const result = await evaluateRule(makeRule(), {
      getMinSampleConfig: async () => ({ minSampleVendors: 2 }),
    });
    assert.deepEqual(result, { skipped: true, reason: 'below_min_sample' });
  });

  it('a failing config read falls back to the DEFAULT floor, not to 1', async () => {
    // This is the branch that matters most. A settings read that throws used
    // to drop the guard to 1 — silently, exactly when nobody is watching — and
    // a rule would then move a live price off a single quote. The fallback now
    // matches settings.service.js's DEFAULT_MIN_SAMPLE_VENDORS.
    mock.state.offers = [makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 40 })];
    const result = await evaluateRule(makeRule(), {
      getMinSampleConfig: async () => { throw new Error('settings unavailable'); },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'below_min_sample');
  });

  it('a failing config read still lets a WELL-SAMPLED class through', async () => {
    // The guard must not become a kill switch: settings being down should cost
    // the thin classes, not every class.
    mock.state.offers = [
      makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 40 }),
      makeOffer({ supplier: 'Avis', effectiveDailyPrice: 44 }),
      makeOffer({ supplier: 'Sixt', effectiveDailyPrice: 48 }),
    ];
    const result = await evaluateRule(makeRule(), {
      getMinSampleConfig: async () => { throw new Error('settings unavailable'); },
    });
    assert.equal(result.skipped, false);
  });
});

// ── runPricingEngine surfacing ───────────────────────────────────────────────

describe('runPricingEngine — below_min_sample surfaces as suggestionsSkipped', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('a thin-market rule lands in suggestionsSkipped (same as no_recent_observations)', async () => {
    mock.state.rules = [makeRule()];
    mock.state.offers = [makeOffer({ supplier: 'Hertz' })];
    mock.state.appSettings.set('tenant:tenant-1:marketPricingConfig', JSON.stringify({ minSampleVendors: 5 }));
    const out = await runPricingEngine({ tenantId: 'tenant-1' });
    assert.equal(out.rulesEvaluated, 1);
    assert.equal(out.suggestionsSkipped, 1);
    assert.equal(out.suggestionsPending, 0);
    assert.equal(out.suggestionsAutoApplied, 0);
    assert.deepEqual(out.errors, []);
    assert.equal(mock.state.suggestionCreates.length, 0);
  });

  it('with the stored floor satisfied the same run produces a pending suggestion', async () => {
    mock.state.rules = [makeRule()];
    mock.state.offers = [
      makeOffer({ supplier: 'Hertz', effectiveDailyPrice: 40 }),
      makeOffer({ supplier: 'Avis', effectiveDailyPrice: 45 }),
    ];
    mock.state.appSettings.set('tenant:tenant-1:marketPricingConfig', JSON.stringify({ minSampleVendors: 2 }));
    const out = await runPricingEngine({ tenantId: 'tenant-1' });
    assert.equal(out.suggestionsSkipped, 0);
    assert.equal(out.suggestionsPending, 1);
    assert.equal(mock.state.suggestionCreates.length, 1);
  });
});
