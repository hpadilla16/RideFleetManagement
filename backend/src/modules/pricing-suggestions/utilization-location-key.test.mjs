/**
 * Which code does a branch's utilisation ladder live under?
 *
 * Two codes name the same place. `MarketScrapeProfile.locationCode` is an IATA
 * AIRPORT code, because that is what a market is; `Location.code` is the
 * tenant's own branch code. They coincide only by luck — International's branch
 * IS 'SJU', so its ladder always resolved, while Corpusa's 'LAXA01' found
 * nothing and the ladder sat inert with no error and no log line.
 *
 * These pin the fallback's shape, and especially its LIMITS: it must not
 * resolve a branch to an airport the tenant does not scrape, and it must never
 * reach across tenants.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findPricingConfigForBranch } from './pricing-suggestion-engine.service.js';

const LADDER = [{ n: 3, type: 'NTH_CHEAPEST', fromPct: 60 }];

/** Minimal prisma stand-in: configs keyed "tenant|code", profiles per tenant. */
function fakePrisma({ configs = {}, profiles = {} } = {}) {
  const calls = { configLookups: [] };
  return {
    calls,
    marketPricingConfig: {
      findUnique: async ({ where }) => {
        const { tenantId, locationCode } = where.tenantId_locationCode;
        calls.configLookups.push(`${tenantId}|${locationCode}`);
        return configs[`${tenantId}|${locationCode}`] || null;
      },
    },
    marketScrapeProfile: {
      findMany: async ({ where }) => (profiles[where.tenantId] || []).map((locationCode) => ({ locationCode })),
    },
  };
}

describe('findPricingConfigForBranch', () => {
  it('takes the exact branch code when a config exists under it (International)', async () => {
    const prisma = fakePrisma({
      configs: { 'irc|SJU': { utilizationRules: LADDER } },
      profiles: { irc: ['SJU'] },
    });
    const out = await findPricingConfigForBranch(prisma, 'irc', 'SJU');
    assert.equal(out.matchedCode, 'SJU');
    assert.deepEqual(out.config.utilizationRules, LADDER);
    assert.deepEqual(prisma.calls.configLookups, ['irc|SJU'], 'no fallback needed, no extra query');
  });

  it('falls back to the airport the tenant scrapes (Corpusa: LAXA01 -> LAX)', async () => {
    // The whole point. Before this, the ladder was silently inert for LAX.
    const prisma = fakePrisma({
      configs: { 'corpusa|LAX': { utilizationRules: LADDER } },
      profiles: { corpusa: ['LAX'] },
    });
    const out = await findPricingConfigForBranch(prisma, 'corpusa', 'LAXA01');
    assert.equal(out.matchedCode, 'LAX');
    assert.deepEqual(out.config.utilizationRules, LADDER);
  });

  it('is case-insensitive about the branch code', async () => {
    const prisma = fakePrisma({
      configs: { 'corpusa|LAX': { utilizationRules: LADDER } },
      profiles: { corpusa: ['lax'] },
    });
    const out = await findPricingConfigForBranch(prisma, 'corpusa', 'laxa01');
    assert.equal(out.matchedCode, 'LAX');
  });

  it('refuses a branch that matches no airport the tenant scrapes', async () => {
    // 'MIA' is a real airport, but this tenant does not scrape it, so there is
    // no market behind it and no ladder to apply. Nothing is the right answer.
    const prisma = fakePrisma({
      configs: { 'corpusa|LAX': { utilizationRules: LADDER } },
      profiles: { corpusa: ['LAX'] },
    });
    const out = await findPricingConfigForBranch(prisma, 'corpusa', 'MIAA01');
    assert.equal(out.config, null);
    assert.equal(out.matchedCode, null);
  });

  it('never reaches into another tenant config', async () => {
    const prisma = fakePrisma({
      configs: { 'other|LAX': { utilizationRules: LADDER } },
      profiles: { corpusa: ['LAX'] },
    });
    const out = await findPricingConfigForBranch(prisma, 'corpusa', 'LAXA01');
    assert.equal(out.config, null);
  });

  it('prefers the LONGER airport code when two could match', async () => {
    // A tenant scraping both 'LAX' and 'LAXB' must not have the shorter code
    // swallow the longer one's branches.
    const prisma = fakePrisma({
      configs: {
        'corpusa|LAX': { utilizationRules: [{ tag: 'short' }] },
        'corpusa|LAXB': { utilizationRules: [{ tag: 'long' }] },
      },
      profiles: { corpusa: ['LAX', 'LAXB'] },
    });
    const out = await findPricingConfigForBranch(prisma, 'corpusa', 'LAXB01');
    assert.equal(out.matchedCode, 'LAXB');
  });

  it('returns nothing rather than throwing when the tenant scrapes nothing', async () => {
    const prisma = fakePrisma({ configs: {}, profiles: {} });
    const out = await findPricingConfigForBranch(prisma, 'corpusa', 'LAXA01');
    assert.equal(out.config, null);
  });

  it('survives a database error on either query', async () => {
    // Going dark over a hiccup would cost every tenant their ladder at once.
    const boom = {
      marketPricingConfig: { findUnique: async () => { throw new Error('db down'); } },
      marketScrapeProfile: { findMany: async () => { throw new Error('db down'); } },
    };
    const out = await findPricingConfigForBranch(boom, 'corpusa', 'LAXA01');
    assert.equal(out.config, null);
  });

  it('needs both a tenant and a branch code', async () => {
    const prisma = fakePrisma();
    assert.equal((await findPricingConfigForBranch(prisma, null, 'LAXA01')).config, null);
    assert.equal((await findPricingConfigForBranch(prisma, 'corpusa', '')).config, null);
  });
});
