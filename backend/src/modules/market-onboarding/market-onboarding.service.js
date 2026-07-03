/**
 * Market Intelligence onboarding wizard — orchestration service (beta.135).
 *
 * Automates the manual switchover we did for "International" (see
 * doc/session-handoff-2026-06-07-beta131-switchover.md) so a NEW tenant that has
 * marketIntelligenceEnabled can self-configure in 4 steps:
 *
 *   1. AIRPORTS  → create the standard MarketScrapeProfile trio per airport
 *                  (1-14 DAILY, 15-28 WEEKLY, 29-60 EVERY_4_DAYS). The droplet
 *                  scheduler then scrapes them on cadence — there is NO on-demand
 *                  trigger by design; discovery reads scheduled-run data.
 *   2. DISCOVERY → read distinct SIPPs already observed for those airports
 *                  (from scheduled runs). Falls back to the SIPP catalog for
 *                  manual selection when no observations exist yet.
 *   3. MAPPING   → map each SIPP ↔ a VehicleType (auto-matched by code) and
 *                  auto-create Rate + RateItem + PricingRule in SUGGEST mode.
 *   4. GUARDRAILS→ floor/ceiling/maxDeltaPct applied to each rule.
 *
 * SAFETY: everything is additive and SUGGEST-only. No Rate.daily is ever
 * auto-applied here — the engine writes PENDING suggestions the tenant approves
 * in the inbox. Rates are created displayOnline=false so they don't auto-quote
 * before the tenant wires them into booking. Per the locked rule, Rate.daily and
 * RateItem.daily are always written together (same seed).
 */
import { prisma } from '../../lib/prisma.js';
import { marketScrapeProfileService } from '../market-scraper/market-scrape-profile.service.js';
import { ratesService } from '../rates/rates.service.js';

// SIPP catalog for the manual-selection fallback. Keep in sync with
// DASHBOARD_SIPP_CODES (settings.service.js) and SIPP_NAMES (frontend).
export const SIPP_CATALOG = [
  'ECAR', 'CCAR', 'ICAR', 'SCAR', 'FCAR', 'PCAR', 'LCAR',
  'CFAR', 'IFAR', 'SFAR', 'FFAR', 'PFAR', 'LFAR', 'RFAR', 'XFAR', 'FJAR', 'FVAR',
  'MVAR', 'SPAR', 'STAR', 'PUAR'
];

// The standard 3-window profile set per airport (mirrors Rate Highway / the
// International setup). The profile service validator only accepts DAILY/WEEKLY,
// so the far-term outlook uses WEEKLY (low-churn far-out prices).
const PROFILE_WINDOWS = [
  { suffix: '1-14 Daily', windowStartDay: 1, windowEndDay: 14, frequency: 'DAILY', lorDays: 3 },
  { suffix: '15-28 Weekly', windowStartDay: 15, windowEndDay: 28, frequency: 'WEEKLY', lorDays: 7 },
  { suffix: '29-60 Outlook', windowStartDay: 29, windowEndDay: 60, frequency: 'WEEKLY', lorDays: 7 }
];

const DISCOVERY_LOOKBACK_DAYS = 14;

function requireTenant(scope) {
  if (!scope?.tenantId) {
    throw Object.assign(new Error('tenantId is required'), { httpStatus: 400 });
  }
  return scope.tenantId;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

export const marketOnboardingService = {
  /**
   * Snapshot of where onboarding stands: the tenant's VehicleTypes, the SIPP
   * catalog, existing scrape profiles, and existing pricing rules. Drives the
   * wizard's initial render + lets it resume.
   */
  async getState(scope = {}) {
    const tenantId = requireTenant(scope);
    const [tenant, vehicleTypes, profiles, rules, locations] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId }, select: { marketIntelligenceEnabled: true } }),
      prisma.vehicleType.findMany({ where: { tenantId }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      prisma.marketScrapeProfile.findMany({ where: { tenantId }, select: { id: true, name: true, locationCode: true, windowStartDay: true, windowEndDay: true, frequency: true, active: true, lastRunAt: true, lastRunStatus: true }, orderBy: [{ locationCode: 'asc' }, { windowStartDay: 'asc' }] }),
      prisma.pricingRule.findMany({ where: { tenantId }, select: { id: true, rateId: true, sipp: true, mode: true, strategy: true, targetN: true, floorPrice: true, ceilingPrice: true, autoMaxDeltaPct: true, active: true }, orderBy: { sipp: 'asc' } }),
      prisma.location.findMany({ where: { tenantId, isActive: true }, select: { code: true, name: true }, orderBy: { code: 'asc' } })
    ]);
    const airports = Array.from(new Set(profiles.map((p) => p.locationCode)));
    return {
      marketIntelligenceEnabled: !!tenant?.marketIntelligenceEnabled,
      vehicleTypes,
      sippCatalog: SIPP_CATALOG,
      locations,
      profiles,
      airports,
      rules
    };
  },

  /**
   * Step 1 — create the standard profile trio for each airport. Idempotent:
   * skips any (airport, window) profile that already exists by name.
   */
  async createAirportProfiles(payload = {}, scope = {}, userId = null) {
    const tenantId = requireTenant(scope);
    const airports = Array.isArray(payload?.airports)
      ? Array.from(new Set(payload.airports.map((a) => String(a || '').trim().toUpperCase()).filter(Boolean)))
      : [];
    if (!airports.length) {
      throw Object.assign(new Error('At least one airport code is required'), { httpStatus: 400 });
    }

    const existing = await prisma.marketScrapeProfile.findMany({
      where: { tenantId, locationCode: { in: airports } },
      select: { name: true }
    });
    const existingNames = new Set(existing.map((p) => p.name));

    const created = [];
    const skipped = [];
    for (const airport of airports) {
      for (const w of PROFILE_WINDOWS) {
        const name = `${airport} ${w.suffix}`;
        if (existingNames.has(name)) { skipped.push(name); continue; }
        // eslint-disable-next-line no-await-in-loop
        const profile = await marketScrapeProfileService.create({
          name,
          locationCode: airport,
          windowStartDay: w.windowStartDay,
          windowEndDay: w.windowEndDay,
          lorDays: w.lorDays,
          frequency: w.frequency,
          sources: ['EXPEDIA'],
          active: true,
          strategy: 'CHEAPEST_MINUS_AMOUNT',
          strategyAmount: 0,
          autoApply: false // research only until the tenant wires a target + rule
        }, { tenantId });
        created.push({ id: profile.id, name: profile.name, locationCode: profile.locationCode });
      }
    }
    return { airports, created, skipped };
  },

  /**
   * Step 2 — discovery. Returns the distinct SIPPs already observed for the
   * given airports (scheduled-run data), each with an observation count, a
   * median daily price (the seed), and an auto-matched VehicleType (by code).
   * When no observations exist yet, `hasObservations=false` and the UI offers
   * the SIPP catalog for manual selection instead.
   */
  async getDiscovery(payload = {}, scope = {}) {
    const tenantId = requireTenant(scope);
    const airports = Array.isArray(payload?.airports)
      ? payload.airports.map((a) => String(a || '').trim().toUpperCase()).filter(Boolean)
      : [];

    const vehicleTypes = await prisma.vehicleType.findMany({
      where: { tenantId }, select: { id: true, code: true, name: true }
    });
    const vtByCode = new Map(vehicleTypes.map((v) => [String(v.code || '').toUpperCase(), v]));

    let discovered = [];
    if (airports.length) {
      const profiles = await prisma.marketScrapeProfile.findMany({
        where: { tenantId, locationCode: { in: airports } },
        select: { id: true }
      });
      const profileIds = profiles.map((p) => p.id);
      if (profileIds.length) {
        const since = new Date(Date.now() - DISCOVERY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
        // NOTE (2026-07-02, RateOffer cutover): this discovery read is legacy-
        // table-only ON PURPOSE for now (fails safe: Kayak-only airports just
        // fall back to the manual SIPP catalog). When switching it to the
        // rate-offer-source adapter, use purpose 'pricing' — medianDaily seeds
        // a live Rate via applyMapping, NOT a display surface.
        const obs = await prisma.marketObservation.findMany({
          where: { profileId: { in: profileIds }, observedAt: { gte: since }, status: 'FOUND', dailyPrice: { not: null } },
          select: { sipp: true, dailyPrice: true }
        });
        const bySipp = new Map();
        for (const o of obs) {
          const sipp = String(o.sipp || '').toUpperCase();
          if (!sipp) continue;
          if (!bySipp.has(sipp)) bySipp.set(sipp, []);
          bySipp.get(sipp).push(Number(o.dailyPrice));
        }
        discovered = Array.from(bySipp.entries()).map(([sipp, prices]) => {
          const sorted = prices.slice().sort((a, b) => a - b);
          const median = sorted.length % 2
            ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
          const vt = vtByCode.get(sipp) || null;
          return {
            sipp,
            observationCount: prices.length,
            medianDaily: round2(median),
            suggestedVehicleTypeId: vt?.id || null,
            suggestedVehicleTypeCode: vt?.code || null
          };
        }).sort((a, b) => b.observationCount - a.observationCount);
      }
    }

    return {
      hasObservations: discovered.length > 0,
      discovered,
      vehicleTypes,
      sippCatalog: SIPP_CATALOG
    };
  },

  /**
   * Step 3 + 4 — apply the SIPP↔VehicleType mapping. For each mapping create (or
   * reuse) a Rate + RateItem (daily mirrored) and upsert a SUGGEST PricingRule
   * with the guardrails. Returns a per-mapping result. Additive + idempotent.
   *
   * payload = {
   *   mappings: [{ sipp, vehicleTypeId, seedDaily }],
   *   guardrails: { floorPct=25, ceilingPct=50, maxDeltaPct=15, targetN=2 }
   * }
   */
  async applyMapping(payload = {}, scope = {}, userId = null) {
    const tenantId = requireTenant(scope);
    const mappings = Array.isArray(payload?.mappings) ? payload.mappings : [];
    if (!mappings.length) {
      throw Object.assign(new Error('At least one SIPP→VehicleType mapping is required'), { httpStatus: 400 });
    }
    const g = payload?.guardrails || {};
    const floorPct = Number.isFinite(Number(g.floorPct)) ? Number(g.floorPct) : 25;
    const ceilingPct = Number.isFinite(Number(g.ceilingPct)) ? Number(g.ceilingPct) : 50;
    const maxDeltaPct = Number.isFinite(Number(g.maxDeltaPct)) ? Number(g.maxDeltaPct) : 15;
    const targetN = Number.isInteger(Number(g.targetN)) && Number(g.targetN) > 0 ? Number(g.targetN) : 2;

    // Validate the VehicleTypes belong to this tenant up front.
    const vtIds = Array.from(new Set(mappings.map((m) => String(m?.vehicleTypeId || '')).filter(Boolean)));
    const vts = await prisma.vehicleType.findMany({ where: { id: { in: vtIds }, tenantId }, select: { id: true, code: true } });
    const vtById = new Map(vts.map((v) => [v.id, v]));

    const results = [];
    for (const m of mappings) {
      const sipp = String(m?.sipp || '').trim().toUpperCase();
      const vehicleTypeId = String(m?.vehicleTypeId || '');
      const seedDaily = round2(m?.seedDaily);
      if (!sipp || !SIPP_CATALOG.includes(sipp)) { results.push({ sipp, ok: false, error: 'invalid SIPP' }); continue; }
      if (!vtById.has(vehicleTypeId)) { results.push({ sipp, ok: false, error: 'vehicleType not in tenant' }); continue; }
      if (!(seedDaily > 0)) { results.push({ sipp, ok: false, error: 'seedDaily must be > 0' }); continue; }

      const rateCode = `MI_${sipp}`;
      const floorPrice = round2(seedDaily * (1 - floorPct / 100));
      const ceilingPrice = round2(seedDaily * (1 + ceilingPct / 100));

      try {
        // eslint-disable-next-line no-await-in-loop
        let rate = await prisma.rate.findFirst({ where: { tenantId, rateCode }, select: { id: true } });
        if (!rate) {
          // eslint-disable-next-line no-await-in-loop
          rate = await ratesService.create({
            rateCode,
            name: `Market Intel — ${sipp}`,
            daily: seedDaily, // locked rule: Rate.daily mirrors RateItem.daily
            active: true,
            displayOnline: false, // engine target only; not a public quote until wired
            rateItems: [{ vehicleTypeId, daily: seedDaily }]
          }, { tenantId });
        } else {
          // Rate exists — ensure the RateItem link + mirrored daily are present.
          // eslint-disable-next-line no-await-in-loop
          await prisma.rateItem.upsert({
            where: { rateId_vehicleTypeId: { rateId: rate.id, vehicleTypeId } },
            create: { rateId: rate.id, vehicleTypeId, daily: seedDaily },
            update: { daily: seedDaily }
          });
        }

        // eslint-disable-next-line no-await-in-loop
        const rule = await prisma.pricingRule.upsert({
          where: { rateId: rate.id },
          create: {
            rateId: rate.id,
            tenantId,
            sipp,
            mode: 'SUGGEST',
            strategy: 'NTH_CHEAPEST',
            targetN,
            paddingPct: 0,
            floorPrice,
            ceilingPrice,
            autoMaxDeltaPct: maxDeltaPct,
            active: true,
            createdBy: userId,
            updatedBy: userId
          },
          update: { sipp, targetN, floorPrice, ceilingPrice, autoMaxDeltaPct: maxDeltaPct, active: true, updatedBy: userId }
        });

        results.push({ sipp, ok: true, rateId: rate.id, ruleId: rule.id, rateCode, floorPrice, ceilingPrice });
      } catch (err) {
        results.push({ sipp, ok: false, error: err?.message || 'failed' });
      }
    }

    return {
      applied: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      mode: 'SUGGEST',
      guardrails: { floorPct, ceilingPct, maxDeltaPct, targetN },
      results
    };
  }
};
