import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import {
  applyRunSuggestions,
  runAutoApplyForProfile,
  getEngineAManagedRateIds,
} from './market-scrape-correction.service.js';

// Service-level money-safety invariants for the base-write mechanism (2026-07-20
// rework: Engine A maintains RateItem.daily; per-date overrides are cleared so the
// base is the single source of truth). Uses a mock prisma harness (no DB).

function installMock() {
  for (const k of ['marketScrapeRun', 'marketObservation', 'rateOffer', 'vehicleType', 'rateDailyPrice', 'rate', 'rateItem', 'marketPricingConfig', 'priceChangeLog', 'marketScrapeProfile', 'tenant']) {
    if (!prisma[k]) prisma[k] = {};
  }
  const state = {
    run: null,
    observations: [],
    offers: [],
    vehicleTypes: [{ id: 'vt-ecar', tenantId: 'tenant-1', code: 'ECAR' }],
    dailyPrices: [],                                   // RateDailyPrice overrides (comparison display only)
    rateItems: [{ vehicleTypeId: 'vt-ecar', daily: 55 }], // current BASE per class (base-vs-base delta)
    headerDaily: 100,
    pricingConfig: null,
    profiles: [],
    runUpdateArgs: null,
    rateItemWrites: [],   // {where, data}
    overrideDeletes: [],  // {where}
    headerWrites: [],     // {where, data}
    auditRows: [],
  };
  const orig = {};
  const set = (path, fn) => { const [a, b] = path.split('.'); orig[path] = prisma[a][b]; prisma[a][b] = fn; };
  set('marketScrapeRun.findFirst', async () => state.run);
  set('marketScrapeRun.update', async (args) => { state.runUpdateArgs = args; return { ...(state.run || {}), ...(args.data || {}) }; });
  set('marketObservation.findMany', async () => state.observations);
  set('rateOffer.findMany', async () => state.offers);
  set('vehicleType.findMany', async () => state.vehicleTypes);
  set('rateDailyPrice.findMany', async () => state.dailyPrices);
  set('rateDailyPrice.deleteMany', async (args) => { state.overrideDeletes.push(args); return { count: 0 }; });
  set('rate.findUnique', async () => ({ id: 'rate-1', daily: state.headerDaily, rateItems: state.rateItems }));
  set('rate.update', async (args) => { state.headerWrites.push(args); return { id: 'rate-1' }; });
  set('rateItem.updateMany', async (args) => { state.rateItemWrites.push(args); return { count: 1 }; });
  set('marketPricingConfig.findUnique', async () => state.pricingConfig);
  set('priceChangeLog.createMany', async ({ data }) => { state.auditRows.push(...data); return { count: data.length }; });
  set('marketScrapeProfile.findFirst', async ({ where }) => state.profiles.find((p) => p.id === where.id) || null);
  set('marketScrapeProfile.findMany', async () => state.profiles);
  set('tenant.findUnique', async () => null);
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

function makeRun(over = {}) {
  const { profile: pOver, ...runOver } = over;
  return {
    id: 'run-1', ...runOver,
    profile: { id: 'profile-1', tenantId: 'tenant-1', locationCode: 'SJU', targetRateId: 'rate-1', strategy: 'MATCH_CHEAPEST', autoApply: true, ...pOver },
  };
}
function obs(daily, date = '2026-05-21') { return { pickupDate: new Date(date), sipp: 'ECAR', dailyPrice: daily, effectiveDailyPrice: daily, vendor: 'Payless', status: 'FOUND' }; }

// Tax-aware config with 0 gross-up (taxes/brokerage empty) so suggestedBase == competitor.
const CFG = { connectionType: 'TITANIUM', taxes: [], brokeragePct: 0, floorBase: 20, ceilingBase: 200, maxDeltaPct: 15, utilizationRules: [] };
const ENV_KEY = 'MARKET_AUTOAPPLY_ENABLED';
function withMaster(val, fn) {
  const prev = process.env[ENV_KEY];
  process.env[ENV_KEY] = val;
  return (async () => { try { return await fn(); } finally { if (prev === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = prev; } })();
}

describe('INVARIANT: ships DARK — master flag off writes nothing', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('AUTO apply with master OFF writes zero base rates even with valid config', async () => {
    await withMaster('false', async () => {
      mock.state.run = makeRun();
      mock.state.pricingConfig = CFG;
      mock.state.observations = [obs(50)];
      const res = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, mode: 'auto' });
      assert.equal(mock.state.rateItemWrites.length, 0, 'no base writes when dark');
      assert.equal(mock.state.overrideDeletes.length, 0);
      assert.equal(res.appliedCount, 0);
      assert.equal(res.masterOff, true);
      assert.equal(mock.state.runUpdateArgs.data.pricesApplied, 0);
    });
  });

  it('runAutoApplyForProfile short-circuits with master off', async () => {
    await withMaster('false', async () => {
      mock.state.profiles = [{ id: 'profile-1', tenantId: 'tenant-1', locationCode: 'SJU', targetRateId: 'rate-1', autoApply: true }];
      const res = await runAutoApplyForProfile('profile-1', { scope: { tenantId: 'tenant-1' } });
      assert.equal(res.skipped, true);
      assert.equal(res.reason, 'master_switch_off');
      assert.equal(mock.state.rateItemWrites.length, 0);
    });
  });
});

describe('INVARIANT: base is written (RateItem.daily), NOT per-date overrides; every date resolves to it', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('within-band suggestion writes RateItem.daily, syncs header, and CLEARS future overrides', async () => {
    await withMaster('true', async () => {
      mock.state.run = makeRun();
      mock.state.pricingConfig = CFG;
      mock.state.rateItems = [{ vehicleTypeId: 'vt-ecar', daily: 55 }];
      // Two in-window dates → still ONE base write (collapsed to nearest date).
      mock.state.observations = [obs(50, '2026-05-21'), obs(51, '2026-05-25')];
      const res = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, mode: 'auto' });
      assert.equal(res.appliedCount, 1, 'one base write per class, not per date');
      // base written to RateItem.daily = nearest date's suggestion (50)
      assert.equal(mock.state.rateItemWrites.length, 1);
      assert.equal(mock.state.rateItemWrites[0].where.rateId, 'rate-1');
      assert.equal(mock.state.rateItemWrites[0].where.vehicleTypeId, 'vt-ecar');
      assert.equal(Number(mock.state.rateItemWrites[0].data.daily), 50);
      // header synced (single-class rate)
      assert.equal(mock.state.headerWrites.length, 1);
      assert.equal(Number(mock.state.headerWrites[0].data.daily), 50);
      // future ENGINE-AUTHORED overrides cleared (scoped to source:'MARKET_A') so
      // the base governs — operator overrides (source null) are excluded by scope.
      assert.equal(mock.state.overrideDeletes.length, 1);
      assert.equal(mock.state.overrideDeletes[0].where.rateId, 'rate-1');
      assert.equal(mock.state.overrideDeletes[0].where.source, 'MARKET_A', 'clear is scoped to engine-authored overrides only');
      assert.ok(mock.state.overrideDeletes[0].where.date.gte instanceof Date);
    });
  });

  it('does NOT sync the header for a MULTI-class rate (header is not the quote source)', async () => {
    await withMaster('true', async () => {
      mock.state.run = makeRun();
      mock.state.pricingConfig = CFG;
      mock.state.rateItems = [{ vehicleTypeId: 'vt-ecar', daily: 55 }, { vehicleTypeId: 'vt-other', daily: 80 }];
      mock.state.observations = [obs(50)];
      await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, mode: 'auto' });
      assert.equal(mock.state.rateItemWrites.length, 1);
      assert.equal(mock.state.headerWrites.length, 0, 'multi-class header left untouched');
    });
  });
});

describe('INVARIANT: no auto-write without guardrails configured (fail-closed HOLD)', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('AUTO with master ON but NO config HOLDs every class', async () => {
    await withMaster('true', async () => {
      mock.state.run = makeRun();
      mock.state.pricingConfig = null;
      mock.state.observations = [obs(40)];
      const res = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, mode: 'auto' });
      assert.equal(mock.state.rateItemWrites.length, 0);
      assert.equal(res.heldCount, 1);
      assert.match(res.held[0].reason, /guardrails not configured/);
      assert.equal(res.heldPct, 100);
    });
  });

  it('AUTO with config MISSING maxDeltaPct HOLDs', async () => {
    await withMaster('true', async () => {
      mock.state.run = makeRun();
      mock.state.pricingConfig = { ...CFG, maxDeltaPct: null };
      mock.state.observations = [obs(50)];
      const res = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, mode: 'auto' });
      assert.equal(res.heldCount, 1);
      assert.equal(mock.state.rateItemWrites.length, 0);
    });
  });
});

describe('INVARIANT: manual/force REQUIRES floor+ceiling (MC3) — HOLDs without bounds', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('manual apply with NO config HOLDs (a human cannot write unbounded)', async () => {
    mock.state.run = makeRun({ profile: { autoApply: false } });
    mock.state.pricingConfig = null;
    mock.state.observations = [obs(50)];
    const res = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, force: true });
    assert.equal(res.heldCount, 1);
    assert.match(res.held[0].reason, /floor\/ceiling not configured/);
    assert.equal(mock.state.rateItemWrites.length, 0);
  });

  it('manual apply WITH bounds seeds the base bypassing the delta band (bootstrap MC2)', async () => {
    mock.state.run = makeRun({ profile: { autoApply: false } });
    // Bounds present, maxDeltaPct tiny — a human seed still applies (band bypassed).
    mock.state.pricingConfig = { ...CFG, maxDeltaPct: 1 };
    mock.state.rateItems = [{ vehicleTypeId: 'vt-ecar', daily: 78 }]; // near all-in, big regime change
    mock.state.observations = [obs(53)]; // grossed-down base
    const res = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, force: true });
    assert.equal(res.appliedCount, 1, 'seed applied in one action');
    assert.equal(Number(mock.state.rateItemWrites[0].data.daily), 53);
    assert.ok(res.warnings.some((w) => /exceeds maxDeltaPct/.test(w.message)), 'delta band bypassed with a warning');
  });
});

describe('INVARIANT: a move beyond maxDeltaPct is HELD (auto, base-vs-base), never applied', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('50% drop vs current RateItem.daily is HELD in AUTO mode', async () => {
    await withMaster('true', async () => {
      mock.state.run = makeRun();
      mock.state.pricingConfig = CFG;              // maxDeltaPct 15
      mock.state.rateItems = [{ vehicleTypeId: 'vt-ecar', daily: 100 }]; // base-vs-base baseline
      mock.state.observations = [obs(50)];
      const res = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, mode: 'auto' });
      assert.equal(res.heldCount, 1);
      assert.equal(res.appliedCount, 0);
      assert.match(res.held[0].reason, /maxDeltaPct breach/);
      assert.equal(mock.state.rateItemWrites.length, 0);
      const a = mock.state.auditRows.find((r) => r.outcome === 'held');
      assert.equal(Number(a.newDaily), 50);
      assert.equal(Number(a.oldDaily), 100);
    });
  });
});

describe('INVARIANT: never write above ceiling (clamp)', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('suggestion above ceiling is clamped DOWN to ceiling and written to the base', async () => {
    await withMaster('true', async () => {
      mock.state.run = makeRun();
      mock.state.pricingConfig = { ...CFG, maxDeltaPct: 100000 };
      mock.state.rateItems = [{ vehicleTypeId: 'vt-ecar', daily: 190 }];
      mock.state.observations = [obs(500)];
      const res = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, mode: 'auto' });
      assert.equal(res.clampedCount, 1);
      assert.equal(Number(mock.state.rateItemWrites[0].data.daily), 200);
      const a = mock.state.auditRows.find((r) => r.outcome === 'clamped');
      assert.equal(Number(a.newDaily), 200);
    });
  });
});

describe('INVARIANT: fallback classes (no own RateItem) are HELD + audit flags the data gap', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('a class with no RateItem is not written; oldFromFallback=true, oldDaily=header', async () => {
    await withMaster('true', async () => {
      mock.state.run = makeRun();
      mock.state.pricingConfig = CFG;
      mock.state.rateItems = []; // ECAR has NO own RateItem → header fallback
      mock.state.headerDaily = 100;
      mock.state.observations = [obs(50)];
      const res = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, mode: 'auto' });
      assert.equal(res.heldCount, 1);
      assert.equal(res.held[0].reason, 'no class-specific rate (fallback)');
      assert.equal(mock.state.rateItemWrites.length, 0);
      const a = mock.state.auditRows[0];
      assert.equal(a.oldFromFallback, true);
      assert.equal(Number(a.oldDaily), 100, 'oldDaily records the header fallback base (data gap)');
    });
  });
});

describe('INVARIANT: audit shape is complete + explains WHY (competitorBasis JSON)', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('PriceChangeLog row carries the money-trail fields and the target basis', async () => {
    await withMaster('true', async () => {
      mock.state.run = makeRun();
      mock.state.pricingConfig = CFG;
      mock.state.rateItems = [{ vehicleTypeId: 'vt-ecar', daily: 55 }];
      mock.state.observations = [obs(50)];
      await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, mode: 'auto' });
      const a = mock.state.auditRows[0];
      assert.equal(a.tenantId, 'tenant-1');
      assert.equal(a.locationCode, 'SJU');
      assert.equal(a.rateId, 'rate-1');
      assert.equal(a.vehicleTypeId, 'vt-ecar');
      assert.ok(a.date instanceof Date);
      assert.equal(Number(a.oldDaily), 55);
      assert.equal(Number(a.newDaily), 50);
      assert.equal(a.engine, 'MARKET_A');
      assert.equal(a.outcome, 'applied');
      assert.equal(a.runId, 'run-1');
      assert.equal(a.oldFromFallback, false);
      const basis = JSON.parse(a.competitorBasis);
      assert.equal(basis.vendor, 'Payless');
      assert.equal(basis.cheapest, 50);
      assert.equal(basis.suggestedAllIn, 50);
      assert.equal(basis.tier, null); // base margin, not a tier
    });
  });
});

describe('EFFICIENCY: already-applied latest run short-circuits (no re-log every 15 min)', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('runAutoApplyForProfile skips when the latest run has autoApplyAt set', async () => {
    await withMaster('true', async () => {
      mock.state.profiles = [{ id: 'profile-1', tenantId: 'tenant-1', locationCode: 'SJU', targetRateId: 'rate-1', autoApply: true }];
      // no explicit runId → auto-selects latest; mark it already applied
      prisma.marketScrapeRun.findFirst = async () => ({ id: 'run-x', autoApplyAt: new Date() });
      const res = await runAutoApplyForProfile('profile-1', { scope: { tenantId: 'tenant-1' } });
      assert.equal(res.skipped, true);
      assert.equal(res.reason, 'already_applied');
      assert.equal(mock.state.rateItemWrites.length, 0);
    });
  });
});

describe('RECONCILIATION: getEngineAManagedRateIds (retire Engine B only where A can write)', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('empty when master flag OFF (dark deploy leaves Engine B untouched)', async () => {
    await withMaster('false', async () => {
      mock.state.profiles = [{ targetRateId: 'rate-1', tenantId: 'tenant-1', locationCode: 'SJU' }];
      mock.state.pricingConfig = CFG;
      const set = await getEngineAManagedRateIds({ tenantId: 'tenant-1' });
      assert.equal(set.size, 0);
    });
  });

  it('includes the rate when master ON + autoApply profile + guardrails configured', async () => {
    await withMaster('true', async () => {
      mock.state.profiles = [{ targetRateId: 'rate-1', tenantId: 'tenant-1', locationCode: 'SJU' }];
      mock.state.pricingConfig = CFG;
      const set = await getEngineAManagedRateIds({ tenantId: 'tenant-1' });
      assert.equal(set.has('rate-1'), true);
    });
  });

  it('EXCLUDES the rate when the location has no guardrail config (A can\'t write → B stays)', async () => {
    await withMaster('true', async () => {
      mock.state.profiles = [{ targetRateId: 'rate-1', tenantId: 'tenant-1', locationCode: 'SJU' }];
      mock.state.pricingConfig = null;
      const set = await getEngineAManagedRateIds({ tenantId: 'tenant-1' });
      assert.equal(set.has('rate-1'), false, 'must not retire B where A cannot write');
    });
  });
});
