import { prisma } from '../../lib/prisma.js';

/**
 * MarketScrapeProfile CRUD + nested run/observation queries.
 *
 * The standalone scraper script (`backend/scripts/market-scraper/`) writes
 * MarketScrapeRun + MarketObservation rows directly via prisma when it runs;
 * this service provides the read API for the dashboard UI plus the CRUD
 * endpoints the admin uses to create/edit profiles.
 *
 * Tenant scoping: every read/write checks `scope.tenantId` so SUPER_ADMIN
 * cross-tenant requests (no tenantId in scope) see all rows, while tenant-
 * scoped requests can never see another tenant's profiles. Same pattern as
 * ratesService / feesService etc.
 *
 * Validation: we enforce field constraints (window range, schedule hour,
 * strategy params required for the chosen strategy) at the service layer so
 * the route layer is thin. Bad input throws Error; route translates to 400.
 */

const VALID_STRATEGIES = new Set([
  'CHEAPEST_MINUS_AMOUNT',
  'MATCH_CHEAPEST',
  'CHEAPEST_PLUS_PCT',
  'STATIC_FLOOR'
]);
const VALID_FREQUENCIES = new Set(['DAILY', 'WEEKLY']);
const VALID_SOURCES = new Set(['EXPEDIA']); // grows over time as we add Kayak / Priceline / etc.

const PROFILE_INCLUDE = {
  targetRate: { select: { id: true, rateCode: true, name: true, locationId: true } }
};

const PROFILE_INCLUDE_WITH_LAST_RUN = {
  ...PROFILE_INCLUDE,
  runs: { orderBy: { startedAt: 'desc' }, take: 1 }
};

function validateProfilePayload(data, { partial = false } = {}) {
  // Helper that throws BadInput with a structured message. Route layer maps
  // to a 400 with that message.
  const must = (cond, msg) => { if (!cond) throw Object.assign(new Error(msg), { httpStatus: 400 }); };

  if (!partial || data.name !== undefined) {
    must(typeof data.name === 'string' && data.name.trim().length > 0, 'name is required');
  }
  if (!partial || data.locationCode !== undefined) {
    must(typeof data.locationCode === 'string' && data.locationCode.trim().length > 0, 'locationCode is required');
  }

  if (!partial || data.windowStartDay !== undefined) {
    const v = Number(data.windowStartDay);
    must(Number.isInteger(v) && v >= 1 && v <= 90, 'windowStartDay must be 1..90');
  }
  if (!partial || data.windowEndDay !== undefined) {
    const v = Number(data.windowEndDay);
    must(Number.isInteger(v) && v >= 1 && v <= 90, 'windowEndDay must be 1..90');
  }
  if (data.windowStartDay !== undefined && data.windowEndDay !== undefined) {
    must(Number(data.windowEndDay) >= Number(data.windowStartDay), 'windowEndDay must be >= windowStartDay');
  }

  if (!partial || data.lorDays !== undefined) {
    const v = Number(data.lorDays);
    must(Number.isInteger(v) && v >= 1 && v <= 30, 'lorDays must be 1..30');
  }

  if (data.frequency !== undefined) {
    must(VALID_FREQUENCIES.has(String(data.frequency)), `frequency must be one of ${[...VALID_FREQUENCIES].join(', ')}`);
  }
  if (data.scheduleHour !== undefined) {
    const v = Number(data.scheduleHour);
    must(Number.isInteger(v) && v >= 0 && v <= 23, 'scheduleHour must be 0..23');
  }
  if (data.scheduleMinute !== undefined) {
    const v = Number(data.scheduleMinute);
    must(Number.isInteger(v) && v >= 0 && v <= 59, 'scheduleMinute must be 0..59');
  }

  if (data.sources !== undefined) {
    must(Array.isArray(data.sources) && data.sources.length > 0, 'sources must be a non-empty array');
    const bad = data.sources.filter((s) => !VALID_SOURCES.has(String(s)));
    must(bad.length === 0, `unknown source(s): ${bad.join(', ')} (valid: ${[...VALID_SOURCES].join(', ')})`);
  }

  if (data.strategy !== undefined) {
    must(VALID_STRATEGIES.has(String(data.strategy)), `strategy must be one of ${[...VALID_STRATEGIES].join(', ')}`);
  }
  // Strategy-specific param requirements. We check whichever strategy is
  // in effect on the row AFTER applying this patch. For a create, that's
  // data.strategy. For a partial update, the caller should pass strategy
  // explicitly when changing param expectations.
  const effectiveStrategy = data.strategy;
  if (effectiveStrategy === 'CHEAPEST_MINUS_AMOUNT' && data.strategyAmount !== undefined) {
    const v = Number(data.strategyAmount);
    must(Number.isFinite(v) && v >= 0, 'strategyAmount must be >= 0');
  }
  if (effectiveStrategy === 'CHEAPEST_PLUS_PCT' && data.strategyPct !== undefined) {
    const v = Number(data.strategyPct);
    must(Number.isFinite(v), 'strategyPct must be a number');
  }
  if (effectiveStrategy === 'STATIC_FLOOR') {
    if (data.strategyFloor !== undefined) {
      const v = Number(data.strategyFloor);
      must(Number.isFinite(v) && v > 0, 'strategyFloor must be > 0 for STATIC_FLOOR strategy');
    } else if (!partial) {
      throw Object.assign(new Error('strategyFloor is required for STATIC_FLOOR strategy'), { httpStatus: 400 });
    }
  }

  if (data.autoApply === true && !data.targetRateId && !partial) {
    // For a CREATE: can't auto-apply without a target. On PATCH, the route
    // re-validates against the merged row state.
    throw Object.assign(new Error('autoApply requires targetRateId'), { httpStatus: 400 });
  }
}

async function ensureLocationCodeBelongsToTenant(locationCode, tenantId) {
  if (!locationCode || !tenantId) return; // SUPER_ADMIN can use any locationCode
  const loc = await prisma.location.findFirst({
    where: { code: locationCode, tenantId },
    select: { id: true }
  });
  if (!loc) {
    throw Object.assign(
      new Error(`Location code "${locationCode}" not found for this tenant`),
      { httpStatus: 400 }
    );
  }
}

async function ensureTargetRateBelongsToTenant(targetRateId, tenantId) {
  if (!targetRateId) return;
  const rate = await prisma.rate.findFirst({
    where: { id: targetRateId, ...(tenantId ? { tenantId } : {}) },
    select: { id: true }
  });
  if (!rate) {
    throw Object.assign(new Error('targetRateId not found or not in this tenant'), { httpStatus: 400 });
  }
}

export const marketScrapeProfileService = {
  async list(scope = {}) {
    return prisma.marketScrapeProfile.findMany({
      where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
      include: PROFILE_INCLUDE_WITH_LAST_RUN,
      orderBy: [{ active: 'desc' }, { name: 'asc' }]
    });
  },

  async getById(id, scope = {}) {
    return prisma.marketScrapeProfile.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: PROFILE_INCLUDE_WITH_LAST_RUN
    });
  },

  async create(data, scope = {}) {
    validateProfilePayload(data, { partial: false });
    const tenantId = scope?.tenantId || data.tenantId;
    if (!tenantId) {
      throw Object.assign(new Error('tenantId required (SUPER_ADMIN must pass tenantId in body)'), { httpStatus: 400 });
    }
    await ensureLocationCodeBelongsToTenant(data.locationCode, tenantId);
    await ensureTargetRateBelongsToTenant(data.targetRateId, tenantId);

    return prisma.marketScrapeProfile.create({
      data: {
        tenantId,
        name: String(data.name).trim(),
        locationCode: String(data.locationCode).trim().toUpperCase(),
        windowStartDay: Number(data.windowStartDay),
        windowEndDay: Number(data.windowEndDay),
        lorDays: Number(data.lorDays ?? 3),
        frequency: data.frequency || 'DAILY',
        scheduleHour: Number(data.scheduleHour ?? 4),
        scheduleMinute: Number(data.scheduleMinute ?? 1),
        runTimezone: data.runTimezone || 'America/Puerto_Rico',
        sources: data.sources,
        active: data.active ?? true,
        strategy: data.strategy || 'CHEAPEST_MINUS_AMOUNT',
        strategyAmount: data.strategyAmount != null ? Number(data.strategyAmount) : null,
        strategyPct: data.strategyPct != null ? Number(data.strategyPct) : null,
        strategyFloor: data.strategyFloor != null ? Number(data.strategyFloor) : null,
        targetRateId: data.targetRateId || null,
        autoApply: data.autoApply ?? false
      },
      include: PROFILE_INCLUDE
    });
  },

  async update(id, data, scope = {}) {
    validateProfilePayload(data, { partial: true });
    const existing = await this.getById(id, scope);
    if (!existing) throw Object.assign(new Error('Profile not found'), { httpStatus: 404 });

    // Re-validate cross-field constraints against the merged row state.
    const merged = { ...existing, ...data };
    if (merged.autoApply === true && !merged.targetRateId) {
      throw Object.assign(new Error('autoApply requires targetRateId'), { httpStatus: 400 });
    }

    if (data.locationCode !== undefined) {
      await ensureLocationCodeBelongsToTenant(data.locationCode, existing.tenantId);
    }
    if (data.targetRateId !== undefined && data.targetRateId !== null) {
      await ensureTargetRateBelongsToTenant(data.targetRateId, existing.tenantId);
    }

    const patch = {};
    const fields = [
      'name', 'locationCode', 'windowStartDay', 'windowEndDay', 'lorDays',
      'frequency', 'scheduleHour', 'scheduleMinute', 'runTimezone',
      'sources', 'active', 'strategy', 'strategyAmount', 'strategyPct',
      'strategyFloor', 'targetRateId', 'autoApply'
    ];
    for (const f of fields) {
      if (data[f] === undefined) continue;
      // Decimal fields get Number()ed (the Prisma driver accepts numbers).
      if (['windowStartDay', 'windowEndDay', 'lorDays', 'scheduleHour', 'scheduleMinute', 'strategyAmount', 'strategyPct', 'strategyFloor'].includes(f)) {
        patch[f] = data[f] === null ? null : Number(data[f]);
      } else if (f === 'locationCode') {
        patch[f] = String(data[f]).trim().toUpperCase();
      } else if (f === 'name') {
        patch[f] = String(data[f]).trim();
      } else {
        patch[f] = data[f];
      }
    }

    return prisma.marketScrapeProfile.update({
      where: { id },
      data: patch,
      include: PROFILE_INCLUDE
    });
  },

  async remove(id, scope = {}) {
    const existing = await this.getById(id, scope);
    if (!existing) throw Object.assign(new Error('Profile not found'), { httpStatus: 404 });
    // onDelete: Cascade on runs/observations FKs takes care of children.
    await prisma.marketScrapeProfile.delete({ where: { id } });
    return { ok: true };
  },

  // ---- Run + observation queries (read-only API for the dashboard) ----

  async listRuns(profileId, scope = {}, { limit = 50 } = {}) {
    const profile = await this.getById(profileId, scope);
    if (!profile) throw Object.assign(new Error('Profile not found'), { httpStatus: 404 });

    return prisma.marketScrapeRun.findMany({
      where: { profileId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(1, Number(limit) || 50), 500)
    });
  },

  async getRun(runId, scope = {}) {
    const run = await prisma.marketScrapeRun.findUnique({
      where: { id: runId },
      include: { profile: { select: { id: true, tenantId: true, name: true } } }
    });
    if (!run) return null;
    if (scope?.tenantId && run.profile.tenantId !== scope.tenantId) return null;
    return run;
  },

  async listObservations(profileId, scope = {}, { runId, pickupDate, sipp, limit = 500 } = {}) {
    const profile = await this.getById(profileId, scope);
    if (!profile) throw Object.assign(new Error('Profile not found'), { httpStatus: 404 });

    const where = { profileId };
    if (runId) where.runId = runId;
    if (pickupDate) where.pickupDate = new Date(pickupDate);
    if (sipp) where.sipp = String(sipp).toUpperCase();

    return prisma.marketObservation.findMany({
      where,
      orderBy: [{ pickupDate: 'asc' }, { sipp: 'asc' }, { dailyPrice: 'asc' }],
      take: Math.min(Math.max(1, Number(limit) || 500), 5000)
    });
  },

  /**
   * Compute the cheapest-per-(date, sipp) for a given run. Used by both the
   * Comparison stage and the Correction stage. Returns an array of:
   *   { pickupDate, sipp, cheapest, cheapestVendor, sampled }
   *
   * (Doesn't write anywhere; just reads.)
   */
  async getRunCheapestPerSipp(runId, scope = {}) {
    const run = await this.getRun(runId, scope);
    if (!run) throw Object.assign(new Error('Run not found'), { httpStatus: 404 });

    const observations = await prisma.marketObservation.findMany({
      where: { runId, status: 'FOUND', dailyPrice: { not: null } },
      orderBy: [{ pickupDate: 'asc' }, { sipp: 'asc' }, { dailyPrice: 'asc' }]
    });

    const byKey = new Map();
    for (const o of observations) {
      const key = `${o.pickupDate.toISOString().slice(0, 10)}|${o.sipp}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, {
          pickupDate: o.pickupDate,
          sipp: o.sipp,
          cheapest: Number(o.dailyPrice),
          cheapestTotal: o.totalPrice != null ? Number(o.totalPrice) : null,
          cheapestEffective: o.effectiveDailyPrice != null ? Number(o.effectiveDailyPrice) : null,
          cheapestVendor: o.vendor,
          sampled: 1
        });
      } else {
        if (Number(o.dailyPrice) < prev.cheapest) {
          prev.cheapest = Number(o.dailyPrice);
          prev.cheapestTotal = o.totalPrice != null ? Number(o.totalPrice) : null;
          prev.cheapestEffective = o.effectiveDailyPrice != null ? Number(o.effectiveDailyPrice) : null;
          prev.cheapestVendor = o.vendor;
        }
        prev.sampled += 1;
      }
    }
    return [...byKey.values()];
  }
};
