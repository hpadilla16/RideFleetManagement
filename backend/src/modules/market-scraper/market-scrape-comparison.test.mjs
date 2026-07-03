import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import {
  applyStrategy,
  aggregateCheapestBySippDate,
  computeRunComparison
} from './market-scrape-comparison.service.js';

// ----- applyStrategy: pure function tests --------------------------------

describe('applyStrategy', () => {
  const baseProfile = { strategy: 'CHEAPEST_MINUS_AMOUNT', strategyAmount: 1 };

  it('CHEAPEST_MINUS_AMOUNT subtracts strategyAmount', () => {
    assert.equal(applyStrategy(25, baseProfile), 24);
  });

  it('MATCH_CHEAPEST returns cheapest unchanged', () => {
    assert.equal(applyStrategy(25, { strategy: 'MATCH_CHEAPEST' }), 25);
  });

  it('CHEAPEST_PLUS_PCT applies percentage uplift', () => {
    // 20 * 1.10 = 22.00
    assert.equal(applyStrategy(20, { strategy: 'CHEAPEST_PLUS_PCT', strategyPct: 10 }), 22);
  });

  it('STATIC_FLOOR clamps below-floor prices up', () => {
    assert.equal(applyStrategy(15, { strategy: 'STATIC_FLOOR', strategyFloor: 20 }), 20);
    assert.equal(applyStrategy(30, { strategy: 'STATIC_FLOOR', strategyFloor: 20 }), 30);
  });

  it('floor clamp applies even when strategy is CHEAPEST_MINUS_AMOUNT (defense in depth)', () => {
    // 18 - 5 = 13, but floor=20 should clamp it to 20.
    assert.equal(applyStrategy(18, { strategy: 'CHEAPEST_MINUS_AMOUNT', strategyAmount: 5, strategyFloor: 20 }), 20);
  });

  it('returns null when cheapest is null/undefined/NaN', () => {
    assert.equal(applyStrategy(null, baseProfile), null);
    assert.equal(applyStrategy(undefined, baseProfile), null);
    assert.equal(applyStrategy('not a number', baseProfile), null);
  });

  it('throws on unknown strategy', () => {
    assert.throws(() => applyStrategy(25, { strategy: 'INVENTED' }), (err) => err.httpStatus === 400);
  });
});

// ----- aggregateCheapestBySippDate: pure function tests -------------------

describe('aggregateCheapestBySippDate', () => {
  it('keeps cheapest dailyPrice per (date, sipp) and tracks vendor + sample count', () => {
    const result = aggregateCheapestBySippDate([
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 25, vendor: 'Hertz', status: 'FOUND' },
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 22, vendor: 'Payless', status: 'FOUND' },
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 30, vendor: 'Avis', status: 'FOUND' }
    ]);
    const row = result.get('2026-05-21|ECAR');
    assert.equal(row.cheapest, 22);
    assert.equal(row.vendor, 'Payless');
    assert.equal(row.sampled, 3);
  });

  it('separates buckets by both date and sipp', () => {
    const result = aggregateCheapestBySippDate([
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 25, status: 'FOUND' },
      { pickupDate: new Date('2026-05-22'), sipp: 'ECAR', dailyPrice: 30, status: 'FOUND' },
      { pickupDate: new Date('2026-05-21'), sipp: 'SFAR', dailyPrice: 50, status: 'FOUND' }
    ]);
    assert.equal(result.size, 3);
    assert.equal(result.get('2026-05-21|ECAR').cheapest, 25);
    assert.equal(result.get('2026-05-22|ECAR').cheapest, 30);
    assert.equal(result.get('2026-05-21|SFAR').cheapest, 50);
  });

  it('skips UNMAPPED and ERROR observations', () => {
    const result = aggregateCheapestBySippDate([
      { pickupDate: new Date('2026-05-21'), sipp: 'UNMAPPED', dailyPrice: 5, status: 'UNMAPPED' },
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 99, status: 'ERROR' },
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 25, status: 'FOUND' }
    ]);
    assert.equal(result.size, 1);
    assert.equal(result.get('2026-05-21|ECAR').cheapest, 25);
  });

  it('skips rows with null/zero/non-numeric dailyPrice', () => {
    const result = aggregateCheapestBySippDate([
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: null, status: 'FOUND' },
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 0, status: 'FOUND' },
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 'NaN', status: 'FOUND' },
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 25, status: 'FOUND' }
    ]);
    assert.equal(result.size, 1);
    assert.equal(result.get('2026-05-21|ECAR').cheapest, 25);
  });
});

// ----- computeRunComparison: integration with prisma mocks ----------------

function installPrismaMock() {
  if (!prisma.marketScrapeRun) prisma.marketScrapeRun = {};
  if (!prisma.marketObservation) prisma.marketObservation = {};
  if (!prisma.rateOffer) prisma.rateOffer = {};
  if (!prisma.rateDailyPrice) prisma.rateDailyPrice = {};
  if (!prisma.vehicleType) prisma.vehicleType = {};

  const state = {
    run: null,           // findFirst returns this
    observations: [],    // findMany returns this
    offers: [],          // rateOffer.findMany returns this (2026-07 dual-read)
    dailyPrices: [],     // findMany returns this
    vehicleTypes: []     // findMany returns this
  };

  const orig = {
    runFindFirst: prisma.marketScrapeRun.findFirst,
    obsFindMany: prisma.marketObservation.findMany,
    offerFindMany: prisma.rateOffer.findMany,
    rdpFindMany: prisma.rateDailyPrice.findMany,
    vtFindMany: prisma.vehicleType.findMany
  };

  prisma.marketScrapeRun.findFirst = async () => state.run;
  prisma.marketObservation.findMany = async () => state.observations;
  prisma.rateOffer.findMany = async () => state.offers;
  prisma.rateDailyPrice.findMany = async () => state.dailyPrices;
  prisma.vehicleType.findMany = async () => state.vehicleTypes;

  return {
    state,
    restore() {
      prisma.marketScrapeRun.findFirst = orig.runFindFirst;
      prisma.marketObservation.findMany = orig.obsFindMany;
      prisma.rateOffer.findMany = orig.offerFindMany;
      prisma.rateDailyPrice.findMany = orig.rdpFindMany;
      prisma.vehicleType.findMany = orig.vtFindMany;
    }
  };
}

describe('computeRunComparison', () => {
  let mock;
  beforeEach(() => { mock = installPrismaMock(); });
  afterEach(() => { mock.restore(); });

  function makeProfile(over = {}) {
    return {
      id: 'profile-1',
      tenantId: 'tenant-1',
      targetRateId: 'rate-1',
      strategy: 'CHEAPEST_MINUS_AMOUNT',
      strategyAmount: 1,
      strategyPct: null,
      strategyFloor: null,
      ...over
    };
  }

  it('produces rows with currentPrice + suggestedPrice + deltas when target rate exists', async () => {
    mock.state.run = { id: 'run-1', profile: makeProfile() };
    mock.state.observations = [
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 25, vendor: 'Hertz', status: 'FOUND' },
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 22, vendor: 'Payless', status: 'FOUND' }
    ];
    mock.state.vehicleTypes = [{ id: 'vt-ecar', tenantId: 'tenant-1', code: 'ECAR', name: 'Economy' }];
    mock.state.dailyPrices = [
      { rateId: 'rate-1', vehicleTypeId: 'vt-ecar', date: new Date('2026-05-21'), daily: 26 }
    ];

    const r = await computeRunComparison('run-1', { scope: { tenantId: 'tenant-1' } });
    assert.equal(r.rows.length, 1);
    const row = r.rows[0];
    assert.equal(row.date, '2026-05-21');
    assert.equal(row.sipp, 'ECAR');
    assert.equal(row.vehicleTypeId, 'vt-ecar');
    assert.equal(row.vehicleTypeMissing, false);
    assert.equal(row.marketCheapest, 22);
    assert.equal(row.marketVendor, 'Payless');
    assert.equal(row.marketSampled, 2);
    assert.equal(row.currentPrice, 26);
    // strategy: 22 - 1 = 21
    assert.equal(row.suggestedPrice, 21);
    // delta: 21 - 26 = -5  (we'd drop the price by $5 to undercut)
    assert.equal(row.deltaAbs, -5);
    assert.equal(row.willUpdate, true);
    assert.equal(r.summary.willUpdate, 1);
    assert.equal(r.summary.withCurrent, 1);
    assert.equal(r.targetRateMissing, false);
  });

  it('flags vehicleTypeMissing when the tenant has no VehicleType for that SIPP', async () => {
    mock.state.run = { id: 'run-1', profile: makeProfile() };
    mock.state.observations = [
      { pickupDate: new Date('2026-05-21'), sipp: 'XPAR', dailyPrice: 99, vendor: 'Sixt', status: 'FOUND' }
    ];
    mock.state.vehicleTypes = []; // no matching VehicleType

    const r = await computeRunComparison('run-1', { scope: { tenantId: 'tenant-1' } });
    assert.equal(r.rows[0].vehicleTypeMissing, true);
    assert.equal(r.rows[0].vehicleTypeId, null);
    assert.equal(r.rows[0].currentPrice, null);
    // We still produced a suggestedPrice — the UI can show "competitor charges
    // $99 here, we don't carry this class". Strategy still applies.
    assert.equal(r.rows[0].suggestedPrice, 98);
    assert.equal(r.rows[0].willUpdate, false, "no currentPrice -> can't decide will-update");
    assert.equal(r.summary.missingVehicleType, 1);
  });

  it('returns targetRateMissing=true and skips currentPrice lookup when profile has no targetRate', async () => {
    mock.state.run = { id: 'run-1', profile: makeProfile({ targetRateId: null }) };
    mock.state.observations = [
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 25, status: 'FOUND' }
    ];
    mock.state.vehicleTypes = [{ id: 'vt-ecar', tenantId: 'tenant-1', code: 'ECAR' }];

    const r = await computeRunComparison('run-1', { scope: { tenantId: 'tenant-1' } });
    assert.equal(r.targetRateMissing, true);
    assert.equal(r.targetRateId, null);
    assert.equal(r.rows[0].currentPrice, null);
    assert.equal(r.rows[0].suggestedPrice, 24);
    assert.equal(r.rows[0].willUpdate, false);
  });

  it('does NOT flag willUpdate when delta is < $0.01 (FP-drift guard)', async () => {
    // Set up so suggested ≈ current within FP rounding noise.
    mock.state.run = { id: 'run-1', profile: makeProfile({ strategy: 'MATCH_CHEAPEST', strategyAmount: null }) };
    mock.state.observations = [
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 25.001, status: 'FOUND' }
    ];
    mock.state.vehicleTypes = [{ id: 'vt-ecar', code: 'ECAR', tenantId: 'tenant-1' }];
    mock.state.dailyPrices = [
      { rateId: 'rate-1', vehicleTypeId: 'vt-ecar', date: new Date('2026-05-21'), daily: 25 }
    ];

    const r = await computeRunComparison('run-1', { scope: { tenantId: 'tenant-1' } });
    assert.equal(r.rows[0].willUpdate, false, 'a ~1¢ delta should not trip an update');
  });

  it('enforces tenant scope (returns 404 when run belongs to a different tenant)', async () => {
    mock.state.run = { id: 'run-1', profile: makeProfile({ tenantId: 'tenant-OTHER' }) };
    await assert.rejects(
      computeRunComparison('run-1', { scope: { tenantId: 'tenant-1' } }),
      (err) => err.httpStatus === 404
    );
  });

  it('throws 404 when run does not exist', async () => {
    mock.state.run = null;
    await assert.rejects(
      computeRunComparison('run-missing', { scope: { tenantId: 'tenant-1' } }),
      (err) => err.httpStatus === 404
    );
  });

  // ----- 2026-07 RateOffer cutover: dual-read through rate-offer-source ----

  function makeOffer(over = {}) {
    return {
      id: 'offer-1',
      runId: 'run-1',
      profileId: 'profile-1',
      observedAt: new Date('2026-07-02T08:00:00Z'),
      source: 'EXPEDIA_DIRECT',
      provider: 'Expedia',
      supplier: 'Hertz',
      pickupDate: new Date('2026-07-10'),
      returnDate: new Date('2026-07-13'),
      lorDays: 3,
      sipp: 'ECAR',
      rawCategory: 'Economy',
      dailyPrice: 25,
      totalPrice: 75,
      effectiveDailyPrice: 25,
      status: 'FOUND',
      ...over
    };
  }

  it('produces comparison rows from a run whose children are RateOffer rows (no legacy observations)', async () => {
    mock.state.run = { id: 'run-1', profile: makeProfile() };
    mock.state.observations = []; // Kayak-era runs write RateOffer only
    mock.state.offers = [
      makeOffer({ id: 'o1', supplier: 'Hertz', dailyPrice: 25 }),
      makeOffer({ id: 'o2', supplier: 'Payless', provider: 'CarRentals', source: 'CARRENTALS', dailyPrice: 22, totalPrice: 66, effectiveDailyPrice: 22 })
    ];
    mock.state.vehicleTypes = [{ id: 'vt-ecar', tenantId: 'tenant-1', code: 'ECAR', name: 'Economy' }];
    mock.state.dailyPrices = [
      { rateId: 'rate-1', vehicleTypeId: 'vt-ecar', date: new Date('2026-07-10'), daily: 26 }
    ];

    const r = await computeRunComparison('run-1', { scope: { tenantId: 'tenant-1' } });
    assert.equal(r.rows.length, 1);
    const row = r.rows[0];
    assert.equal(row.date, '2026-07-10');
    assert.equal(row.marketCheapest, 22);
    assert.equal(row.marketVendor, 'Payless');
    assert.equal(row.marketSampled, 2);
    assert.equal(row.suggestedPrice, 21); // 22 - $1
    assert.equal(row.currentPrice, 26);
    assert.equal(row.willUpdate, true);
  });

  it('collapses multi-provider quotes for the same supplier into one ladder entry (agency min across OTAs)', async () => {
    mock.state.run = { id: 'run-1', profile: makeProfile({ targetRateId: null }) };
    mock.state.offers = [
      makeOffer({ id: 'o1', supplier: 'Sixt', provider: 'Priceline', source: 'CARRENTALS', dailyPrice: 30 }),
      makeOffer({ id: 'o2', supplier: 'Sixt', provider: 'EconomyBookings', source: 'CARRENTALS', dailyPrice: 27 }),
      makeOffer({ id: 'o3', supplier: 'Avis', provider: 'Expedia', source: 'EXPEDIA_DIRECT', dailyPrice: 35 })
    ];

    const r = await computeRunComparison('run-1', { scope: { tenantId: 'tenant-1' } });
    assert.equal(r.rows.length, 1);
    const row = r.rows[0];
    // Sixt collapses to its cheapest quote across providers → ladder is
    // [Sixt 27, Avis 35]: two agencies, not three OTA listings.
    assert.equal(row.marketCheapest, 27);
    assert.equal(row.marketVendor, 'Sixt');
    assert.equal(row.marketSampled, 3); // raw quotes sampled stays 3
  });

  it('excludes offers with an empty supplier from the competitive rows', async () => {
    mock.state.run = { id: 'run-1', profile: makeProfile({ targetRateId: null }) };
    mock.state.offers = [
      makeOffer({ id: 'anon', supplier: '', dailyPrice: 5 }), // anonymous lowball must not win
      makeOffer({ id: 'named', supplier: 'Dollar', dailyPrice: 28 })
    ];

    const r = await computeRunComparison('run-1', { scope: { tenantId: 'tenant-1' } });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].marketCheapest, 28);
    assert.equal(r.rows[0].marketVendor, 'Dollar');
    assert.equal(r.rows[0].marketSampled, 1);
  });

  it('gates KAYAK-source offers out of the comparison while KAYAK_EFFECTIVE_IS_ALL_IN is unset (purpose=pricing)', async () => {
    delete process.env.KAYAK_EFFECTIVE_IS_ALL_IN;
    mock.state.run = { id: 'run-1', profile: makeProfile({ targetRateId: null }) };
    mock.state.offers = [
      makeOffer({ id: 'kayak', source: 'KAYAK', provider: 'Priceline', supplier: 'Sixt', dailyPrice: 10 }), // teaser
      makeOffer({ id: 'direct', source: 'EXPEDIA_DIRECT', provider: 'Expedia', supplier: 'Hertz', dailyPrice: 25 })
    ];

    const r = await computeRunComparison('run-1', { scope: { tenantId: 'tenant-1' } });
    assert.equal(r.rows.length, 1);
    // The $10 Kayak teaser must NOT drive the suggestion — only the direct row.
    assert.equal(r.rows[0].marketCheapest, 25);
    assert.equal(r.rows[0].marketVendor, 'Hertz');
  });
});
