import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { applyRunSuggestions } from './market-scrape-correction.service.js';

// Gate + base-write coverage for the Correction stage. The comprehensive money
// guardrail invariants live in market-autoapply.test.mjs + market-autoapply-
// guardrails.test.mjs; this file focuses on the request gates and the base-write
// wiring (RateItem.daily + future-override clear).
//
// 2026-07-20 rework: Engine A now writes the BASE (RateItem.daily), not per-date
// RateDailyPrice overrides. A no-force apply is AUTO and DARK unless the master
// switch is on; MANUAL (force) requires floor+ceiling bounds configured.

function installMock() {
  for (const k of ['marketScrapeRun', 'marketObservation', 'rateOffer', 'vehicleType', 'rateDailyPrice', 'rate', 'rateItem', 'marketPricingConfig', 'priceChangeLog', 'tenant']) {
    if (!prisma[k]) prisma[k] = {};
  }
  const state = {
    run: null,
    observations: [],
    offers: [],
    vehicleTypes: [{ id: 'vt-ecar', tenantId: 'tenant-1', code: 'ECAR' }],
    dailyPrices: [],
    rateItems: [{ vehicleTypeId: 'vt-ecar', daily: 30 }],
    headerDaily: 100,
    // Wide bounds so the money math is obvious; manual requires floor+ceiling present.
    pricingConfig: { connectionType: 'TITANIUM', taxes: [], brokeragePct: 0, floorBase: 1, ceilingBase: 1000, maxDeltaPct: 100000, utilizationRules: [] },
    runUpdateArgs: null,
    rateItemWrites: [],
    overrideDeletes: [],
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
  set('rate.update', async () => ({ id: 'rate-1' }));
  set('rateItem.updateMany', async (args) => { state.rateItemWrites.push(args); return { count: 1 }; });
  set('marketPricingConfig.findUnique', async () => state.pricingConfig);
  set('priceChangeLog.createMany', async ({ data }) => { state.auditRows.push(...data); return { count: data.length }; });
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
  const { profile: profileOver, ...runOver } = over;
  return {
    id: 'run-1',
    ...runOver,
    profile: {
      id: 'profile-1', tenantId: 'tenant-1', locationCode: 'SJU', targetRateId: 'rate-1',
      strategy: 'CHEAPEST_MINUS_AMOUNT', strategyAmount: 1, autoApply: true, ...profileOver,
    },
  };
}
function obs(daily, sipp = 'ECAR', date = '2026-05-21') { return { pickupDate: new Date(date), sipp, dailyPrice: daily, effectiveDailyPrice: daily, vendor: 'Payless', status: 'FOUND' }; }

describe('applyRunSuggestions — base-write happy path (manual/force)', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('writes the base RateItem.daily and clears future overrides', async () => {
    mock.state.run = makeRun();
    mock.state.observations = [obs(22)]; // 22 - 1 = 21
    const result = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, force: true });
    assert.equal(mock.state.rateItemWrites.length, 1);
    assert.equal(mock.state.rateItemWrites[0].where.vehicleTypeId, 'vt-ecar');
    assert.equal(Number(mock.state.rateItemWrites[0].data.daily), 21);
    assert.equal(mock.state.overrideDeletes.length, 1, 'future overrides cleared');
    assert.equal(result.appliedCount, 1);
    assert.equal(mock.state.runUpdateArgs.data.pricesApplied, 1);
  });

  it('no-op when the base is unchanged within $0.01 (still clears overrides, no counted write)', async () => {
    mock.state.run = makeRun({ profile: { strategy: 'MATCH_CHEAPEST', strategyAmount: null } });
    mock.state.rateItems = [{ vehicleTypeId: 'vt-ecar', daily: 30 }];
    mock.state.observations = [obs(30.001)]; // rounds to 30.00 == current base
    const result = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, force: true });
    assert.equal(result.appliedCount, 0);
    assert.equal(mock.state.runUpdateArgs.data.pricesApplied, 0);
  });

  it('skips a class with no VehicleType (unmapped SIPP)', async () => {
    mock.state.run = makeRun();
    mock.state.observations = [obs(99, 'XPAR'), obs(22, 'ECAR')];
    const result = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, force: true });
    assert.equal(mock.state.rateItemWrites.length, 1);
    assert.equal(mock.state.rateItemWrites[0].where.vehicleTypeId, 'vt-ecar');
    assert.equal(result.appliedCount, 1);
  });
});

describe('applyRunSuggestions — gates', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('rejects when profile.autoApply is false and not forced', async () => {
    mock.state.run = makeRun({ profile: { autoApply: false } });
    await assert.rejects(
      applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' } }),
      (err) => err.message.includes('not configured for auto-apply') && err.httpStatus === 400
    );
    assert.equal(mock.state.rateItemWrites.length, 0);
  });

  it('allows manual override via force=true (Apply button on UI)', async () => {
    mock.state.run = makeRun({ profile: { autoApply: false } });
    mock.state.observations = [obs(22)];
    const result = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, force: true });
    assert.equal(result.appliedCount, 1);
    assert.equal(mock.state.rateItemWrites.length, 1);
  });

  it('rejects when profile has no targetRateId', async () => {
    mock.state.run = makeRun({ profile: { targetRateId: null } });
    await assert.rejects(
      applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, force: true }),
      (err) => err.message.includes('targetRateId') && err.httpStatus === 400
    );
  });

  it('rejects when runId is missing', async () => {
    await assert.rejects(
      applyRunSuggestions('', { scope: { tenantId: 'tenant-1' } }),
      (err) => err.message.includes('runId required')
    );
  });
});
