import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { ratesService } from '../rates/rates.service.js';
import { applyRunSuggestions } from './market-scrape-correction.service.js';

// Correction reuses ratesService.importDailyPrices() under the hood so the
// real upsert/batch logic is exercised in the rates tests. Here we just verify
// the gate (autoApply / targetRate / writable filter) and that the run row's
// pricesApplied counter gets updated.

function installMock() {
  if (!prisma.marketScrapeRun) prisma.marketScrapeRun = {};
  if (!prisma.marketObservation) prisma.marketObservation = {};
  if (!prisma.rateOffer) prisma.rateOffer = {};
  if (!prisma.vehicleType) prisma.vehicleType = {};
  if (!prisma.rateDailyPrice) prisma.rateDailyPrice = {};

  const state = {
    run: null,
    observations: [],
    offers: [], // RateOffer children (2026-07 dual-read via rate-offer-source)
    vehicleTypes: [],
    dailyPrices: [],
    runUpdateArgs: null,
    importCalls: [],
    importReturnsImported: 0
  };

  const orig = {
    runFindFirst: prisma.marketScrapeRun.findFirst,
    runUpdate: prisma.marketScrapeRun.update,
    obsFindMany: prisma.marketObservation.findMany,
    offerFindMany: prisma.rateOffer.findMany,
    vtFindMany: prisma.vehicleType.findMany,
    rdpFindMany: prisma.rateDailyPrice.findMany,
    importDailyPrices: ratesService.importDailyPrices
  };

  prisma.marketScrapeRun.findFirst = async () => state.run;
  prisma.marketScrapeRun.update = async (args) => {
    state.runUpdateArgs = args;
    return { ...(state.run || {}), ...(args.data || {}) };
  };
  prisma.marketObservation.findMany = async () => state.observations;
  prisma.rateOffer.findMany = async () => state.offers;
  prisma.vehicleType.findMany = async () => state.vehicleTypes;
  prisma.rateDailyPrice.findMany = async () => state.dailyPrices;
  ratesService.importDailyPrices = async (rateId, rows, scope, options) => {
    state.importCalls.push({ rateId, rows, scope, options });
    return {
      imported: state.importReturnsImported || rows.length,
      addedCount: 0,
      updatedCount: rows.length,
      unchangedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      added: [],
      updated: rows,
      unchanged: [],
      skipped: [],
      errors: [],
      rate: { id: rateId }
    };
  };

  return {
    state,
    restore() {
      prisma.marketScrapeRun.findFirst = orig.runFindFirst;
      prisma.marketScrapeRun.update = orig.runUpdate;
      prisma.marketObservation.findMany = orig.obsFindMany;
      prisma.rateOffer.findMany = orig.offerFindMany;
      prisma.vehicleType.findMany = orig.vtFindMany;
      prisma.rateDailyPrice.findMany = orig.rdpFindMany;
      ratesService.importDailyPrices = orig.importDailyPrices;
    }
  };
}

function makeRun(over = {}) {
  const { profile: profileOver, ...runOver } = over;
  return {
    id: 'run-1',
    ...runOver,
    profile: {
      id: 'profile-1',
      tenantId: 'tenant-1',
      targetRateId: 'rate-1',
      strategy: 'CHEAPEST_MINUS_AMOUNT',
      strategyAmount: 1,
      autoApply: true,
      ...profileOver
    }
  };
}

describe('applyRunSuggestions — happy path', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('writes rows where willUpdate=true and updates pricesApplied counter', async () => {
    mock.state.run = makeRun();
    mock.state.observations = [
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 22, vendor: 'Payless', status: 'FOUND' }
    ];
    mock.state.vehicleTypes = [{ id: 'vt-ecar', tenantId: 'tenant-1', code: 'ECAR' }];
    mock.state.dailyPrices = [
      { rateId: 'rate-1', vehicleTypeId: 'vt-ecar', date: new Date('2026-05-21'), daily: 30 }
    ];

    const result = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' } });

    // strategy: 22 - 1 = 21, current = 30, delta -9 > $0.01 -> willUpdate=true
    assert.equal(mock.state.importCalls.length, 1);
    const call = mock.state.importCalls[0];
    assert.equal(call.rateId, 'rate-1');
    assert.equal(call.rows.length, 1);
    assert.equal(call.rows[0].Sipp, 'ECAR');
    assert.equal(call.rows[0].PickUpDate, '2026-05-21');
    assert.equal(call.rows[0].SuggestedAmount, 21);
    assert.equal(call.options.silentSkipUnknownTypes, true);
    assert.equal(call.scope.tenantId, 'tenant-1');

    assert.equal(result.appliedCount, 1);
    assert.equal(mock.state.runUpdateArgs.data.pricesApplied, 1);
  });

  it('filters out rows where willUpdate=false (delta < $0.01)', async () => {
    mock.state.run = makeRun({ profile: { strategy: 'MATCH_CHEAPEST', strategyAmount: null } });
    mock.state.observations = [
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 30.001, status: 'FOUND' }
    ];
    mock.state.vehicleTypes = [{ id: 'vt-ecar', tenantId: 'tenant-1', code: 'ECAR' }];
    mock.state.dailyPrices = [
      { rateId: 'rate-1', vehicleTypeId: 'vt-ecar', date: new Date('2026-05-21'), daily: 30 }
    ];

    const result = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' } });
    // no writable rows -> importDailyPrices never called, but pricesApplied still set to 0.
    assert.equal(mock.state.importCalls.length, 0);
    assert.equal(result.appliedCount, 0);
    assert.equal(mock.state.runUpdateArgs.data.pricesApplied, 0);
  });

  it('filters out rows missing vehicleTypeId (no VehicleType for that SIPP)', async () => {
    mock.state.run = makeRun();
    mock.state.observations = [
      // SIPP that has no VehicleType in the tenant catalog
      { pickupDate: new Date('2026-05-21'), sipp: 'XPAR', dailyPrice: 99, status: 'FOUND' },
      // SIPP that does have one
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 22, status: 'FOUND' }
    ];
    mock.state.vehicleTypes = [{ id: 'vt-ecar', tenantId: 'tenant-1', code: 'ECAR' }];
    mock.state.dailyPrices = [
      { rateId: 'rate-1', vehicleTypeId: 'vt-ecar', date: new Date('2026-05-21'), daily: 30 }
    ];

    const result = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' } });
    // Only ECAR row gets written; XPAR is filtered (vehicleTypeId null)
    assert.equal(mock.state.importCalls[0].rows.length, 1);
    assert.equal(mock.state.importCalls[0].rows[0].Sipp, 'ECAR');
    assert.equal(result.appliedCount, 1);
  });
});

describe('applyRunSuggestions — gates', () => {
  let mock;
  beforeEach(() => { mock = installMock(); });
  afterEach(() => { mock.restore(); });

  it('rejects when profile.autoApply is false (research-only profile)', async () => {
    mock.state.run = makeRun({ profile: { autoApply: false } });
    await assert.rejects(
      applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' } }),
      (err) => err.message.includes('not configured for auto-apply') && err.httpStatus === 400
    );
    assert.equal(mock.state.importCalls.length, 0);
  });

  it('allows manual override via force=true (Apply button on UI)', async () => {
    mock.state.run = makeRun({ profile: { autoApply: false } });
    mock.state.observations = [
      { pickupDate: new Date('2026-05-21'), sipp: 'ECAR', dailyPrice: 22, status: 'FOUND' }
    ];
    mock.state.vehicleTypes = [{ id: 'vt-ecar', tenantId: 'tenant-1', code: 'ECAR' }];
    mock.state.dailyPrices = [
      { rateId: 'rate-1', vehicleTypeId: 'vt-ecar', date: new Date('2026-05-21'), daily: 30 }
    ];

    const result = await applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' }, force: true });
    assert.equal(result.appliedCount, 1);
    assert.equal(mock.state.importCalls.length, 1);
  });

  it('rejects when profile has no targetRateId (cannot decide which Rate to write to)', async () => {
    mock.state.run = makeRun({ profile: { targetRateId: null } });
    await assert.rejects(
      applyRunSuggestions('run-1', { scope: { tenantId: 'tenant-1' } }),
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
