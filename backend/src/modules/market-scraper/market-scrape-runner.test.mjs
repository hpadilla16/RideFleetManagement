import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { runProfile } from './market-scrape-runner.service.js';

// These tests monkey-patch the prisma client and inject a fake scraper so the
// runner's orchestration (run row creation, observation persistence, status
// computation, last-run tracking) can be verified without Playwright, the
// network, or a live database.

const FIXED_NOW = new Date('2026-05-20T12:00:00.000Z');

const sippMap = {
  exact: { Economy: 'ECAR', 'Standard SUV': 'SFAR', 'Mini Van': 'MVAR' },
  keyword_fallback: [['suv', 'SFAR'], ['mini van', 'MVAR'], ['economy', 'ECAR']]
};

function makeProfile(overrides = {}) {
  return {
    id: 'profile-1',
    tenantId: 'tenant-1',
    name: 'SJU 1-3 Daily',
    locationCode: 'SJU',
    windowStartDay: 1,
    windowEndDay: 3,
    lorDays: 3,
    sources: ['EXPEDIA'],
    active: true,
    ...overrides
  };
}

function makeFakeScraper(scriptedResults) {
  // scriptedResults is an array of results returned in order, one per call.
  // Each entry is { listings: [...] } | { error: '...' }.
  const calls = [];
  let i = 0;
  return {
    calls,
    async scrapeOneSearch(args) {
      calls.push(args);
      const next = scriptedResults[i] !== undefined ? scriptedResults[i] : { listings: [] };
      i += 1;
      return next;
    },
    async wait(_ms) { /* skip delay in tests */ },
    closed: false,
    async close() { this.closed = true; }
  };
}

// Common harness: monkey-patch prisma for the 3 tables runner touches.
function installPrismaMock() {
  if (!prisma.marketScrapeProfile) prisma.marketScrapeProfile = {};
  if (!prisma.marketScrapeRun) prisma.marketScrapeRun = {};
  if (!prisma.marketObservation) prisma.marketObservation = {};

  const state = {
    profile: null,                   // findFirst returns this
    profileUpdateArgs: null,
    runRow: null,                    // create returns / update mutates this
    runUpdateArgs: null,
    observationCreateManyCalls: []   // each entry is the createMany args.data
  };

  const orig = {
    profileFindFirst: prisma.marketScrapeProfile.findFirst,
    profileUpdate: prisma.marketScrapeProfile.update,
    runCreate: prisma.marketScrapeRun.create,
    runUpdate: prisma.marketScrapeRun.update,
    observationCreateMany: prisma.marketObservation.createMany
  };

  prisma.marketScrapeProfile.findFirst = async () => state.profile;
  prisma.marketScrapeProfile.update = async (args) => {
    state.profileUpdateArgs = args;
    return { ...state.profile, ...(args.data || {}) };
  };
  prisma.marketScrapeRun.create = async (args) => {
    state.runRow = { id: 'run-1', ...(args.data || {}) };
    return state.runRow;
  };
  prisma.marketScrapeRun.update = async (args) => {
    state.runUpdateArgs = args;
    return { ...state.runRow, ...(args.data || {}) };
  };
  prisma.marketObservation.createMany = async (args) => {
    state.observationCreateManyCalls.push(args.data);
    return { count: args.data.length };
  };

  return {
    state,
    restore() {
      prisma.marketScrapeProfile.findFirst = orig.profileFindFirst;
      prisma.marketScrapeProfile.update = orig.profileUpdate;
      prisma.marketScrapeRun.create = orig.runCreate;
      prisma.marketScrapeRun.update = orig.runUpdate;
      prisma.marketObservation.createMany = orig.observationCreateMany;
    }
  };
}

describe('runProfile — happy path (all requests ok)', () => {
  let mock;
  beforeEach(() => { mock = installPrismaMock(); });
  afterEach(() => { mock.restore(); });

  it('iterates the window, persists observations, marks run SUCCESS', async () => {
    mock.state.profile = makeProfile(); // 1..3, lorDays=3 -> 3 iterations
    const scraper = makeFakeScraper([
      { listings: [
          { category: 'Economy', dailyPrice: 25, totalPrice: 90, vendor: 'Hertz' },
          { category: 'Standard SUV', dailyPrice: 50, totalPrice: 165, vendor: 'Avis' }
      ] },
      { listings: [
          { category: 'Economy', dailyPrice: 28, totalPrice: 99, vendor: 'Hertz' }
      ] },
      { listings: [
          { category: 'Mini Van', dailyPrice: 75, totalPrice: 240, vendor: 'Budget' }
      ] }
    ]);

    const result = await runProfile('profile-1', {
      scope: { tenantId: 'tenant-1' },
      scraper,
      sippMap,
      now: FIXED_NOW
    });

    assert.equal(result.status, 'SUCCESS');
    assert.equal(result.requestsOk, 3);
    assert.equal(result.requestsErr, 0);
    assert.equal(result.observationsCount, 4);
    assert.equal(scraper.calls.length, 3);
    // Pickup dates should be FIXED_NOW + 1, +2, +3 (UTC).
    assert.equal(scraper.calls[0].pickupDate.toISOString().slice(0, 10), '2026-05-21');
    assert.equal(scraper.calls[2].pickupDate.toISOString().slice(0, 10), '2026-05-23');
    // Return date = pickup + lorDays(3).
    assert.equal(scraper.calls[0].returnDate.toISOString().slice(0, 10), '2026-05-24');
    // Run row got a terminal update with status SUCCESS.
    assert.equal(mock.state.runUpdateArgs.data.status, 'SUCCESS');
    assert.equal(mock.state.runUpdateArgs.data.observationsCount, 4);
    // Profile last-run tracking updated.
    assert.equal(mock.state.profileUpdateArgs.data.lastRunStatus, 'SUCCESS');
    assert.ok(mock.state.profileUpdateArgs.data.lastSuccessAt instanceof Date);
    // Browser/session closed.
    assert.equal(scraper.closed, true);
  });
});

describe('runProfile — partial / failed paths', () => {
  let mock;
  beforeEach(() => { mock = installPrismaMock(); });
  afterEach(() => { mock.restore(); });

  it('reports PARTIAL when some requests succeed and some fail', async () => {
    mock.state.profile = makeProfile({ windowStartDay: 1, windowEndDay: 2 });
    const scraper = makeFakeScraper([
      { listings: [{ category: 'Economy', dailyPrice: 25, totalPrice: 90 }] },
      { error: 'expedia-technical-problems' }
    ]);

    const result = await runProfile('profile-1', {
      scope: { tenantId: 'tenant-1' },
      scraper, sippMap, now: FIXED_NOW
    });

    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.requestsOk, 1);
    assert.equal(result.requestsErr, 1);
    assert.equal(result.observationsCount, 1);
    assert.equal(result.errorMessage, 'expedia-technical-problems');
    assert.equal(mock.state.profileUpdateArgs.data.lastRunStatus, 'PARTIAL');
    // PARTIAL counts as a usable run, so lastSuccessAt advances.
    assert.ok(mock.state.profileUpdateArgs.data.lastSuccessAt instanceof Date);
  });

  it('reports FAILED when every request errors and does NOT advance lastSuccessAt', async () => {
    mock.state.profile = makeProfile({ windowStartDay: 1, windowEndDay: 2 });
    const scraper = makeFakeScraper([
      { error: 'nav: timeout' },
      { error: 'expedia-no-results' }
    ]);

    const result = await runProfile('profile-1', {
      scope: { tenantId: 'tenant-1' },
      scraper, sippMap, now: FIXED_NOW
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.requestsOk, 0);
    assert.equal(result.requestsErr, 2);
    assert.equal(result.observationsCount, 0);
    assert.equal(result.errorMessage, 'nav: timeout'); // first one wins
    assert.equal(mock.state.profileUpdateArgs.data.lastRunStatus, 'FAILED');
    assert.equal(mock.state.profileUpdateArgs.data.lastSuccessAt, undefined,
      'FAILED runs must not touch lastSuccessAt');
  });

  it('treats a thrown scrapeOneSearch as a per-request error (not a total run failure)', async () => {
    mock.state.profile = makeProfile({ windowStartDay: 1, windowEndDay: 2 });
    const scraper = {
      calls: [],
      async scrapeOneSearch(args) {
        this.calls.push(args);
        if (this.calls.length === 1) throw new Error('boom');
        return { listings: [{ category: 'Economy', dailyPrice: 22, totalPrice: 70 }] };
      },
      async wait() {},
      closed: false,
      async close() { this.closed = true; }
    };

    const result = await runProfile('profile-1', {
      scope: { tenantId: 'tenant-1' },
      scraper, sippMap, now: FIXED_NOW
    });

    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.requestsErr, 1);
    assert.equal(result.requestsOk, 1);
    assert.match(result.errorMessage, /scraper-threw: boom/);
    assert.equal(scraper.closed, true);
  });
});

describe('runProfile — observation mapping', () => {
  let mock;
  beforeEach(() => { mock = installPrismaMock(); });
  afterEach(() => { mock.restore(); });

  it('maps category->sipp, computes effectiveDailyPrice, sets status=FOUND', async () => {
    mock.state.profile = makeProfile({ windowStartDay: 1, windowEndDay: 1, lorDays: 3 });
    const scraper = makeFakeScraper([
      { listings: [{ category: 'Standard SUV', dailyPrice: 50, totalPrice: 165, vendor: 'Avis' }] }
    ]);

    await runProfile('profile-1', { scope: { tenantId: 'tenant-1' }, scraper, sippMap, now: FIXED_NOW });

    const batch = mock.state.observationCreateManyCalls[0];
    assert.equal(batch.length, 1);
    assert.equal(batch[0].sipp, 'SFAR');
    assert.equal(batch[0].status, 'FOUND');
    assert.equal(batch[0].source, 'EXPEDIA');
    assert.equal(batch[0].vendor, 'Avis');
    assert.equal(batch[0].rawCategory, 'Standard SUV');
    assert.equal(Number(batch[0].dailyPrice), 50);
    assert.equal(Number(batch[0].totalPrice), 165);
    // effectiveDaily = 165 / 3 = 55.00
    assert.equal(Number(batch[0].effectiveDailyPrice), 55);
  });

  it('keeps unmapped categories with status=UNMAPPED and sipp="UNMAPPED"', async () => {
    mock.state.profile = makeProfile({ windowStartDay: 1, windowEndDay: 1 });
    const scraper = makeFakeScraper([
      { listings: [{ category: 'Quantum Hovercar', dailyPrice: 99, totalPrice: 300 }] }
    ]);

    await runProfile('profile-1', { scope: { tenantId: 'tenant-1' }, scraper, sippMap, now: FIXED_NOW });

    const batch = mock.state.observationCreateManyCalls[0];
    assert.equal(batch[0].sipp, 'UNMAPPED');
    assert.equal(batch[0].status, 'UNMAPPED');
    assert.equal(batch[0].rawCategory, 'Quantum Hovercar');
  });

  it('skips listings with neither dailyPrice nor totalPrice', async () => {
    mock.state.profile = makeProfile({ windowStartDay: 1, windowEndDay: 1 });
    const scraper = makeFakeScraper([
      { listings: [
          { category: 'Economy', dailyPrice: null, totalPrice: null },
          { category: 'Economy', dailyPrice: 20, totalPrice: 60 }
      ] }
    ]);

    await runProfile('profile-1', { scope: { tenantId: 'tenant-1' }, scraper, sippMap, now: FIXED_NOW });

    const batch = mock.state.observationCreateManyCalls[0];
    assert.equal(batch.length, 1, 'price-less listings should be filtered out');
    assert.equal(Number(batch[0].dailyPrice), 20);
  });
});

describe('runProfile — validation + tenant scoping', () => {
  let mock;
  beforeEach(() => { mock = installPrismaMock(); });
  afterEach(() => { mock.restore(); });

  it('rejects when profile is not found in tenant scope', async () => {
    mock.state.profile = null;
    await assert.rejects(
      runProfile('profile-1', { scope: { tenantId: 'tenant-1' }, scraper: makeFakeScraper([]), sippMap }),
      (err) => err.message.includes('Profile not found') && err.httpStatus === 404
    );
  });

  it('rejects when profile is inactive', async () => {
    mock.state.profile = makeProfile({ active: false });
    await assert.rejects(
      runProfile('profile-1', { scope: { tenantId: 'tenant-1' }, scraper: makeFakeScraper([]), sippMap }),
      (err) => err.message.includes('Profile is inactive') && err.httpStatus === 400
    );
  });

  it('rejects when sources does not include EXPEDIA', async () => {
    mock.state.profile = makeProfile({ sources: ['KAYAK'] });
    await assert.rejects(
      runProfile('profile-1', { scope: { tenantId: 'tenant-1' }, scraper: makeFakeScraper([]), sippMap }),
      (err) => err.message.includes('must include EXPEDIA')
    );
  });

  it('rejects when scraper is missing', async () => {
    mock.state.profile = makeProfile();
    await assert.rejects(
      runProfile('profile-1', { scope: { tenantId: 'tenant-1' }, sippMap }),
      (err) => err.message.includes('scraper.scrapeOneSearch is required')
    );
  });

  it('rejects when sippMap is missing', async () => {
    mock.state.profile = makeProfile();
    await assert.rejects(
      runProfile('profile-1', { scope: { tenantId: 'tenant-1' }, scraper: makeFakeScraper([]) }),
      (err) => err.message.includes('sippMap is required')
    );
  });

  it('allows running without tenant scope (cron path)', async () => {
    mock.state.profile = makeProfile();
    const scraper = makeFakeScraper([
      { listings: [{ category: 'Economy', dailyPrice: 20, totalPrice: 60 }] }
    ]);
    const result = await runProfile('profile-1', { scraper, sippMap, now: FIXED_NOW });
    // We just want it to not throw on missing tenantId — runner should run.
    assert.equal(result.requestsOk, 3);
  });
});
