import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { runPricingEngine } from './pricing-suggestion-engine.service.js';

// Step 6 (one engine per rate): Engine B (PricingRule → Rate.daily) must RETIRE
// from any rate that Engine A (Market Intelligence auto-apply) owns and can write.
// The overlap set comes from getEngineAManagedRateIds, which is gated on the master
// switch + a fully-configured MarketPricingConfig — so a DARK deploy retires nothing.

function installMock() {
  for (const k of ['pricingRule', 'pricingSuggestion', 'rate', 'rateItem', 'marketScrapeProfile', 'marketPricingConfig', 'marketObservation', 'rateOffer']) {
    if (!prisma[k]) prisma[k] = {};
  }
  const state = {
    rules: [],
    profiles: [],
    pricingConfig: null,
    suggestionCreates: [],
    rateUpdates: [],
  };
  const orig = {};
  const set = (path, fn) => { const [a, b] = path.split('.'); orig[path] = prisma[a][b]; prisma[a][b] = fn; };
  set('pricingSuggestion.updateMany', async () => ({ count: 0 }));
  set('pricingSuggestion.create', async ({ data }) => { state.suggestionCreates.push(data); return { id: 'sg', ...data }; });
  set('pricingRule.findMany', async () => state.rules);
  set('rate.update', async (args) => { state.rateUpdates.push(args); return { id: args.where.id }; });
  set('rateItem.updateMany', async () => ({ count: 1 }));
  set('marketScrapeProfile.findMany', async () => state.profiles);
  set('marketPricingConfig.findUnique', async () => state.pricingConfig);
  set('marketObservation.findMany', async () => []); // no competitor rows → evaluateRule skips
  set('rateOffer.findMany', async () => []);
  // $transaction: run the array of thenables (they already executed as promises here)
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

function ruleFor(rateId, locationCode = 'SJU') {
  return {
    id: `rule-${rateId}`, rateId, tenantId: 'tenant-1', strategy: 'NTH_CHEAPEST', targetN: 1, mode: 'AUTO',
    paddingPct: 0, floorPrice: 10, ceilingPrice: 500, autoMaxDeltaPct: 20, active: true, sipp: 'ECAR',
    rate: { id: rateId, tenantId: 'tenant-1', rateCode: rateId, daily: 50, locationId: 'loc-1', location: { id: 'loc-1', code: locationCode } },
  };
}

const CFG = { floorBase: 20, ceilingBase: 200, maxDeltaPct: 15 };
const ENV_KEY = 'MARKET_AUTOAPPLY_ENABLED';
function withMaster(val, fn) {
  const prev = process.env[ENV_KEY];
  process.env[ENV_KEY] = val;
  return (async () => { try { return await fn(); } finally { if (prev === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = prev; } })();
}

describe('runPricingEngine — retire Engine B from Engine A rates', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('retires the rule whose rate Engine A manages (master ON + config) — no suggestion written', async () => {
    await withMaster('true', async () => {
      mock.state.rules = [ruleFor('rate-1'), ruleFor('rate-2')];
      // Engine A manages rate-1 via an autoApply profile with configured guardrails.
      mock.state.profiles = [{ targetRateId: 'rate-1', tenantId: 'tenant-1', locationCode: 'SJU' }];
      mock.state.pricingConfig = CFG;
      const out = await runPricingEngine({ tenantId: 'tenant-1' });
      assert.equal(out.rulesEvaluated, 2);
      assert.equal(out.suggestionsRetired, 1, 'rate-1 retired');
      // rate-1 never produced a suggestion/rate update; rate-2 was evaluated (skipped: no obs).
      assert.equal(mock.state.rateUpdates.length, 0);
      assert.equal(mock.state.suggestionCreates.length, 0);
    });
  });

  it('DARK: master OFF retires nothing — both rules evaluated as before', async () => {
    await withMaster('false', async () => {
      mock.state.rules = [ruleFor('rate-1'), ruleFor('rate-2')];
      mock.state.profiles = [{ targetRateId: 'rate-1', tenantId: 'tenant-1', locationCode: 'SJU' }];
      mock.state.pricingConfig = CFG;
      const out = await runPricingEngine({ tenantId: 'tenant-1' });
      assert.equal(out.suggestionsRetired, 0, 'nothing retired on a dark deploy');
    });
  });
});
