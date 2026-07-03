import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { marketScrapeProfileService } from './market-scrape-profile.service.js';

// These tests monkey-patch the prisma client methods the service uses, so we
// can validate input handling + the cheapest-per-SIPP aggregation without
// needing a live database. Tenant-isolation + persistence are covered by the
// tenant-isolation suite (added once the migration is applied to staging).

describe('marketScrapeProfileService.create — validation', () => {
  let origCreate, origLocFindFirst, origRateFindFirst;
  let capturedArgs;

  beforeEach(() => {
    capturedArgs = null;
    origCreate = prisma.marketScrapeProfile?.create;
    origLocFindFirst = prisma.location.findFirst;
    origRateFindFirst = prisma.rate.findFirst;

    // marketScrapeProfile may not exist as a client property until the
    // generated client is rebuilt. Install a stub so tests pass even if the
    // generated client is stale (which is the case until prisma generate
    // runs against the new schema).
    if (!prisma.marketScrapeProfile) {
      prisma.marketScrapeProfile = {};
    }
    prisma.marketScrapeProfile.create = async (args) => {
      capturedArgs = args;
      return { id: 'stub-id', ...(args?.data || {}) };
    };
    // Permissive location/rate stubs so the tenant-belongs-to checks pass
    // by default. Tests that want to exercise the negative paths set them
    // to return null explicitly.
    prisma.location.findFirst = async () => ({ id: 'loc-stub' });
    prisma.rate.findFirst = async () => ({ id: 'rate-stub' });
  });

  afterEach(() => {
    if (origCreate) prisma.marketScrapeProfile.create = origCreate;
    prisma.location.findFirst = origLocFindFirst;
    prisma.rate.findFirst = origRateFindFirst;
  });

  const validBase = {
    name: 'SJU 1-14 Daily',
    locationCode: 'SJU',
    windowStartDay: 1,
    windowEndDay: 14,
    lorDays: 3,
    sources: ['EXPEDIA'],
    strategy: 'CHEAPEST_MINUS_AMOUNT',
    strategyAmount: 1
  };

  it('creates with default schedule (4:01 AM) and defaults applied', async () => {
    await marketScrapeProfileService.create({ ...validBase }, { tenantId: 'tenant-1' });
    assert.equal(capturedArgs.data.scheduleHour, 4);
    assert.equal(capturedArgs.data.scheduleMinute, 1);
    assert.equal(capturedArgs.data.frequency, 'DAILY');
    assert.equal(capturedArgs.data.active, true);
    assert.equal(capturedArgs.data.autoApply, false);
    assert.equal(capturedArgs.data.tenantId, 'tenant-1');
    assert.equal(capturedArgs.data.locationCode, 'SJU'); // uppercased
  });

  it('uppercases locationCode even when input is lowercase', async () => {
    await marketScrapeProfileService.create(
      { ...validBase, locationCode: 'mco' },
      { tenantId: 'tenant-1' }
    );
    assert.equal(capturedArgs.data.locationCode, 'MCO');
  });

  it('rejects windowEndDay < windowStartDay', async () => {
    await assert.rejects(
      marketScrapeProfileService.create(
        { ...validBase, windowStartDay: 15, windowEndDay: 5 },
        { tenantId: 'tenant-1' }
      ),
      (err) => err.message.includes('windowEndDay must be >= windowStartDay') && err.httpStatus === 400
    );
  });

  it('rejects windowStartDay outside 1..90', async () => {
    await assert.rejects(
      marketScrapeProfileService.create(
        { ...validBase, windowStartDay: 0 },
        { tenantId: 'tenant-1' }
      ),
      (err) => err.message.includes('windowStartDay must be 1..90')
    );
    await assert.rejects(
      marketScrapeProfileService.create(
        { ...validBase, windowStartDay: 100, windowEndDay: 100 },
        { tenantId: 'tenant-1' }
      ),
      (err) => err.message.includes('windowStartDay must be 1..90')
    );
  });

  it('rejects lorDays outside 1..30', async () => {
    await assert.rejects(
      marketScrapeProfileService.create({ ...validBase, lorDays: 0 }, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('lorDays must be 1..30')
    );
    await assert.rejects(
      marketScrapeProfileService.create({ ...validBase, lorDays: 31 }, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('lorDays must be 1..30')
    );
  });

  it('rejects scheduleHour outside 0..23', async () => {
    await assert.rejects(
      marketScrapeProfileService.create({ ...validBase, scheduleHour: 24 }, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('scheduleHour must be 0..23')
    );
  });

  it('rejects unknown source', async () => {
    await assert.rejects(
      marketScrapeProfileService.create(
        { ...validBase, sources: ['EXPEDIA', 'BOGUS'] },
        { tenantId: 'tenant-1' }
      ),
      (err) => err.message.includes('unknown source')
    );
  });

  it('rejects empty sources array', async () => {
    await assert.rejects(
      marketScrapeProfileService.create({ ...validBase, sources: [] }, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('sources must be a non-empty array')
    );
  });

  it('rejects create without sources (regression: Codex P2 on PR #64)', async () => {
    // Without this check, Prisma would error at the DB layer ("Argument
    // `sources` is missing.") returning an opaque 500. We want a 400 from
    // the service so the client gets actionable feedback.
    const { sources, ...withoutSources } = validBase;
    await assert.rejects(
      marketScrapeProfileService.create(withoutSources, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('sources is required') && err.httpStatus === 400
    );
  });

  it('rejects unknown strategy', async () => {
    await assert.rejects(
      marketScrapeProfileService.create(
        { ...validBase, strategy: 'INVENTED_STRATEGY' },
        { tenantId: 'tenant-1' }
      ),
      (err) => err.message.includes('strategy must be one of')
    );
  });

  it('rejects STATIC_FLOOR strategy without strategyFloor', async () => {
    await assert.rejects(
      marketScrapeProfileService.create(
        { ...validBase, strategy: 'STATIC_FLOOR', strategyAmount: null, strategyFloor: null },
        { tenantId: 'tenant-1' }
      ),
      (err) => err.message.includes('strategyFloor is required')
    );
  });

  it('accepts STATIC_FLOOR with valid floor', async () => {
    await marketScrapeProfileService.create(
      { ...validBase, strategy: 'STATIC_FLOOR', strategyFloor: 25 },
      { tenantId: 'tenant-1' }
    );
    assert.equal(capturedArgs.data.strategy, 'STATIC_FLOOR');
    assert.equal(Number(capturedArgs.data.strategyFloor), 25);
  });

  it('rejects autoApply=true without targetRateId', async () => {
    await assert.rejects(
      marketScrapeProfileService.create(
        { ...validBase, autoApply: true },
        { tenantId: 'tenant-1' }
      ),
      (err) => err.message.includes('autoApply requires targetRateId')
    );
  });

  it('accepts autoApply=true when targetRateId is set', async () => {
    await marketScrapeProfileService.create(
      { ...validBase, autoApply: true, targetRateId: 'rate-1' },
      { tenantId: 'tenant-1' }
    );
    assert.equal(capturedArgs.data.autoApply, true);
    assert.equal(capturedArgs.data.targetRateId, 'rate-1');
  });

  it('rejects when location.findFirst returns null (location not in tenant)', async () => {
    prisma.location.findFirst = async () => null;
    await assert.rejects(
      marketScrapeProfileService.create(validBase, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('Location code "SJU" not found for this tenant')
    );
  });

  it('rejects when targetRateId not in tenant', async () => {
    prisma.rate.findFirst = async () => null;
    await assert.rejects(
      marketScrapeProfileService.create(
        { ...validBase, targetRateId: 'rate-from-other-tenant' },
        { tenantId: 'tenant-1' }
      ),
      (err) => err.message.includes('targetRateId not found')
    );
  });

  it('requires tenantId from scope or body', async () => {
    await assert.rejects(
      marketScrapeProfileService.create(validBase, {}),
      (err) => err.message.includes('tenantId required')
    );
  });
});

describe('marketScrapeProfileService.update — merged-state revalidation (Codex P1)', () => {
  let origFindFirst, origUpdate, origLocFindFirst, origRateFindFirst;
  let updateCalled;

  const existingProfile = {
    id: 'profile-1',
    tenantId: 'tenant-1',
    name: 'SJU 1-14 Daily',
    locationCode: 'SJU',
    windowStartDay: 1,
    windowEndDay: 14,
    lorDays: 3,
    frequency: 'DAILY',
    scheduleHour: 4,
    scheduleMinute: 1,
    runTimezone: 'America/Puerto_Rico',
    sources: ['EXPEDIA'],
    active: true,
    strategy: 'CHEAPEST_MINUS_AMOUNT',
    strategyAmount: 1,
    strategyPct: null,
    strategyFloor: null,
    targetRateId: null,
    autoApply: false
  };

  beforeEach(() => {
    updateCalled = false;
    origFindFirst = prisma.marketScrapeProfile?.findFirst;
    origUpdate = prisma.marketScrapeProfile?.update;
    origLocFindFirst = prisma.location.findFirst;
    origRateFindFirst = prisma.rate.findFirst;
    if (!prisma.marketScrapeProfile) prisma.marketScrapeProfile = {};
    prisma.marketScrapeProfile.findFirst = async () => existingProfile;
    prisma.marketScrapeProfile.update = async () => {
      updateCalled = true;
      return { ...existingProfile };
    };
    prisma.location.findFirst = async () => ({ id: 'loc-stub' });
    prisma.rate.findFirst = async () => ({ id: 'rate-stub' });
  });

  afterEach(() => {
    if (origFindFirst) prisma.marketScrapeProfile.findFirst = origFindFirst;
    if (origUpdate) prisma.marketScrapeProfile.update = origUpdate;
    prisma.location.findFirst = origLocFindFirst;
    prisma.rate.findFirst = origRateFindFirst;
  });

  it('rejects PATCH that creates invalid window via partial update', async () => {
    // existing: windowStartDay=1, windowEndDay=14. PATCH only windowStartDay=20.
    // Before the fix: accepted. After the fix: rejected because merged state
    // is windowStartDay=20, windowEndDay=14, which is invalid.
    await assert.rejects(
      marketScrapeProfileService.update('profile-1', { windowStartDay: 20 }, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('windowEndDay must be >= windowStartDay') && err.httpStatus === 400
    );
    assert.equal(updateCalled, false, 'prisma.update must not be called on validation failure');
  });

  it('rejects PATCH that creates invalid window via the other side', async () => {
    // existing: 1..14. PATCH windowEndDay=0. Merged: 1..0 invalid.
    await assert.rejects(
      marketScrapeProfileService.update('profile-1', { windowEndDay: 0 }, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('windowEndDay must be 1..90') || err.message.includes('windowEndDay must be >= windowStartDay')
    );
  });

  it('rejects PATCH changing strategy to STATIC_FLOOR without setting strategyFloor', async () => {
    // existing: CHEAPEST_MINUS_AMOUNT with no floor. PATCH to STATIC_FLOOR
    // without providing strategyFloor. Merged state has no floor → invalid.
    await assert.rejects(
      marketScrapeProfileService.update('profile-1', { strategy: 'STATIC_FLOOR' }, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('strategyFloor must be > 0 for STATIC_FLOOR strategy')
    );
  });

  it('accepts PATCH that keeps the merged window valid', async () => {
    // PATCH windowEndDay=20. Merged: 1..20 — valid.
    await marketScrapeProfileService.update(
      'profile-1',
      { windowEndDay: 20 },
      { tenantId: 'tenant-1' }
    );
    assert.equal(updateCalled, true);
  });

  it('accepts PATCH switching strategy to STATIC_FLOOR with floor included', async () => {
    await marketScrapeProfileService.update(
      'profile-1',
      { strategy: 'STATIC_FLOOR', strategyFloor: 25 },
      { tenantId: 'tenant-1' }
    );
    assert.equal(updateCalled, true);
  });

  it('rejects PATCH enabling autoApply without targetRateId on merged state', async () => {
    await assert.rejects(
      marketScrapeProfileService.update('profile-1', { autoApply: true }, { tenantId: 'tenant-1' }),
      (err) => err.message.includes('autoApply requires targetRateId')
    );
  });
});

describe('marketScrapeProfileService.getRunCheapestPerSipp — aggregation', () => {
  let origGetRun, origObsFindMany, origOfferFindMany;

  beforeEach(() => {
    origGetRun = marketScrapeProfileService.getRun;
    if (!prisma.marketObservation) prisma.marketObservation = {};
    if (!prisma.rateOffer) prisma.rateOffer = {};
    origObsFindMany = prisma.marketObservation.findMany;
    origOfferFindMany = prisma.rateOffer.findMany;
    // Dual-read (2026-07): getRunCheapestPerSipp also queries RateOffer now.
    prisma.rateOffer.findMany = async () => [];

    marketScrapeProfileService.getRun = async () => ({ id: 'run-1', profile: { tenantId: 'tenant-1' } });
  });

  afterEach(() => {
    marketScrapeProfileService.getRun = origGetRun;
    if (origObsFindMany) prisma.marketObservation.findMany = origObsFindMany;
    if (origOfferFindMany) prisma.rateOffer.findMany = origOfferFindMany;
  });

  it('returns cheapest per (date, sipp) across multiple vendors', async () => {
    prisma.marketObservation.findMany = async () => [
      // 2026-05-12, IFAR: $18 Advantage and $25 Sixt — cheapest is $18 Advantage
      { pickupDate: new Date('2026-05-12'), sipp: 'IFAR', dailyPrice: '18.00', totalPrice: '82.00', effectiveDailyPrice: '27.33', vendor: 'Advantage', status: 'FOUND' },
      { pickupDate: new Date('2026-05-12'), sipp: 'IFAR', dailyPrice: '25.00', totalPrice: '120.00', effectiveDailyPrice: '40.00', vendor: 'Sixt', status: 'FOUND' },
      // 2026-05-12, ECAR: $7 Payless only
      { pickupDate: new Date('2026-05-12'), sipp: 'ECAR', dailyPrice: '7.00', totalPrice: '41.00', effectiveDailyPrice: '13.67', vendor: 'Payless', status: 'FOUND' },
      // 2026-05-13, IFAR: $20 Advantage
      { pickupDate: new Date('2026-05-13'), sipp: 'IFAR', dailyPrice: '20.00', totalPrice: '85.00', effectiveDailyPrice: '28.33', vendor: 'Advantage', status: 'FOUND' }
    ];

    const out = await marketScrapeProfileService.getRunCheapestPerSipp('run-1', { tenantId: 'tenant-1' });
    assert.equal(out.length, 3);

    const ifar512 = out.find((r) => r.sipp === 'IFAR' && r.pickupDate.toISOString().startsWith('2026-05-12'));
    assert.ok(ifar512);
    assert.equal(ifar512.cheapest, 18);
    assert.equal(ifar512.cheapestVendor, 'Advantage');
    assert.equal(ifar512.sampled, 2);

    const ecar512 = out.find((r) => r.sipp === 'ECAR');
    assert.equal(ecar512.cheapest, 7);
    assert.equal(ecar512.sampled, 1);
  });

  it('skips observations with null dailyPrice (prisma where filter would, but verify in-memory too)', async () => {
    prisma.marketObservation.findMany = async () => [
      { pickupDate: new Date('2026-05-12'), sipp: 'IFAR', dailyPrice: '18.00', vendor: 'Advantage', status: 'FOUND' }
    ];
    const out = await marketScrapeProfileService.getRunCheapestPerSipp('run-1', { tenantId: 'tenant-1' });
    assert.equal(out.length, 1);
    assert.equal(out[0].cheapest, 18);
  });
});
