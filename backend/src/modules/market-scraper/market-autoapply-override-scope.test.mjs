import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../../lib/prisma.js';
import { ratesService } from '../rates/rates.service.js';
import { applyRunSuggestions } from './market-scrape-correction.service.js';

// DB-backed money bite-proof (2026-07-20 operator-override preservation).
// Runs the REAL applyRunSuggestions end-to-end and proves:
//   - the engine updates the BASE (RateItem.daily),
//   - it clears its OWN future override (source:'MARKET_A'),
//   - an OPERATOR override (source null — a holiday/event surge) SURVIVES and still
//     WINS over the base in resolveForRental for its specific date.
//
// Requires a live dev DB (localhost:5432/fleet_management). node --test isolates
// each test file in its own process, so the mock-based suites don't bleed in.

const TAG = `mkt-ovr-${Date.now()}`;
const ids = {};
let surgeISO;
const prevMaster = process.env.MARKET_AUTOAPPLY_ENABLED;

function dPlus(days) { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + days); return d; }

describe('operator overrides are never collateral to the engine base write', () => {
  before(async () => {
    process.env.MARKET_AUTOAPPLY_ENABLED = 'true';
    const surge = dPlus(30);
    surgeISO = surge.toISOString().slice(0, 10);

    const tenant = await prisma.tenant.create({ data: { name: TAG, slug: TAG, marketIntelligenceEnabled: true } });
    ids.tenant = tenant.id;
    const loc = await prisma.location.create({ data: { tenantId: tenant.id, code: 'SJU', name: `${TAG} SJU` } });
    ids.loc = loc.id;
    const vt = await prisma.vehicleType.create({ data: { tenantId: tenant.id, code: 'ECAR', name: 'Economy' } });
    ids.vt = vt.id;
    const rate = await prisma.rate.create({ data: { tenantId: tenant.id, rateCode: `${TAG}-R`, name: `${TAG} rate`, locationId: loc.id, daily: 55 } });
    ids.rate = rate.id;
    await prisma.rateItem.create({ data: { rateId: rate.id, vehicleTypeId: vt.id, daily: 55 } });
    await prisma.marketPricingConfig.create({ data: { tenantId: tenant.id, locationCode: 'SJU', connectionType: 'TITANIUM', taxes: [], brokeragePct: 0, floorBase: 20, ceilingBase: 200, maxDeltaPct: 15 } });

    // Future-dated overrides (one per date — RateDailyPrice is unique on rate+vt+date):
    // an operator-authored surge (source null) and an engine-authored one ('MARKET_A').
    // The engine clear must take ONLY the latter.
    await prisma.rateDailyPrice.create({ data: { rateId: rate.id, vehicleTypeId: vt.id, date: surge, daily: 300, source: null } }); // operator surge (D+30)
    await prisma.rateDailyPrice.create({ data: { rateId: rate.id, vehicleTypeId: vt.id, date: dPlus(31), daily: 40, source: 'MARKET_A' } }); // engine (should be cleared)

    const profile = await prisma.marketScrapeProfile.create({ data: {
      tenantId: tenant.id, name: `${TAG}-P`, locationCode: 'SJU', windowStartDay: 1, windowEndDay: 14, lorDays: 1,
      sources: ['EXPEDIA'], strategy: 'MATCH_CHEAPEST', targetRateId: rate.id, autoApply: true, active: true,
    } });
    ids.profile = profile.id;
    const run = await prisma.marketScrapeRun.create({ data: { profileId: profile.id, status: 'SUCCESS', finishedAt: new Date() } });
    ids.run = run.id;
    await prisma.marketObservation.create({ data: {
      runId: run.id, profileId: profile.id, pickupDate: dPlus(3), returnDate: dPlus(4), lorDays: 1,
      sipp: 'ECAR', vendor: 'Payless', source: 'EXPEDIA', dailyPrice: 50, totalPrice: 50, effectiveDailyPrice: 50, status: 'FOUND',
    } });
  });

  after(async () => {
    if (prevMaster === undefined) delete process.env.MARKET_AUTOAPPLY_ENABLED; else process.env.MARKET_AUTOAPPLY_ENABLED = prevMaster;
    // FK-safe teardown.
    await prisma.marketObservation.deleteMany({ where: { runId: ids.run } }).catch(() => {});
    await prisma.marketScrapeRun.deleteMany({ where: { profileId: ids.profile } }).catch(() => {});
    await prisma.marketScrapeProfile.deleteMany({ where: { id: ids.profile } }).catch(() => {});
    await prisma.rateDailyPrice.deleteMany({ where: { rateId: ids.rate } }).catch(() => {});
    await prisma.rateItem.deleteMany({ where: { rateId: ids.rate } }).catch(() => {});
    await prisma.rate.deleteMany({ where: { id: ids.rate } }).catch(() => {});
    await prisma.marketPricingConfig.deleteMany({ where: { tenantId: ids.tenant } }).catch(() => {});
    await prisma.vehicleType.deleteMany({ where: { id: ids.vt } }).catch(() => {});
    await prisma.location.deleteMany({ where: { id: ids.loc } }).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: ids.tenant } }).catch(() => {});
  });

  it('base updated, engine override cleared, operator surge survives and WINS in resolveForRental', async () => {
    const res = await applyRunSuggestions(ids.run, { scope: { tenantId: ids.tenant }, mode: 'auto' });
    assert.equal(res.appliedCount, 1, 'base written once for the class');

    // Base moved 55 -> 50 (within 15% band).
    const item = await prisma.rateItem.findFirst({ where: { rateId: ids.rate, vehicleTypeId: ids.vt } });
    assert.equal(Number(item.daily), 50, 'RateItem.daily (base) updated');
    const rate = await prisma.rate.findUnique({ where: { id: ids.rate } });
    assert.equal(Number(rate.daily), 50, 'single-class header synced');

    // Engine-authored override cleared; operator override survives untouched.
    const overrides = await prisma.rateDailyPrice.findMany({ where: { rateId: ids.rate }, orderBy: { daily: 'desc' } });
    assert.equal(overrides.length, 1, 'only the operator override remains');
    assert.equal(Number(overrides[0].daily), 300);
    assert.equal(overrides[0].source, null, 'operator override (source null) preserved');

    // The operator surge still WINS over the base for its date at quote time.
    const quote = await ratesService.resolveForRental(
      { vehicleTypeId: ids.vt, pickupLocationId: ids.loc, pickupAt: `${surgeISO}T14:00:00.000Z`, returnAt: `${surgeISO}T20:00:00.000Z` },
      { tenantId: ids.tenant },
    );
    assert.ok(quote, 'quote resolved');
    const surgeDay = (quote.dailyBreakdown || []).find((r) => r.date === surgeISO);
    assert.ok(surgeDay, 'surge day present in breakdown');
    assert.equal(surgeDay.dailyRate, 300, 'operator surge wins over the new base');
    assert.equal(surgeDay.overridden, true);
  });
});
