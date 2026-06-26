import { prisma } from '../../lib/prisma.js';

/**
 * Loaner Program per-class rate book (2026-06-25). Decision D1: REUSE the rental Rate/RateItem
 * tables, tagged with Rate.purpose = LOANER, so a tenant has exactly one LOANER price book whose
 * RateItem rows hold the per-class loaner daily rate. ratesService.resolveForRental (+ the rental
 * admin list) exclude purpose = LOANER, so these rates NEVER leak into a retail rental quote.
 * Plan: doc/loaner-selfservice-class-upgrade-plan-2026-06-25.md.
 */
const LOANER_RATE_CODE = '__LOANER_PROGRAM__';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
}

export const loanerRateService = {
  LOANER_RATE_CODE,

  /** Find (or create) the tenant's single LOANER-purpose Rate row. */
  async getOrCreateLoanerRate(tenantId, client = prisma) {
    const where = { tenantId_rateCode: { tenantId: tenantId ?? null, rateCode: LOANER_RATE_CODE } };
    let rate = await client.rate.findUnique({ where }).catch(() => null);
    if (!rate) {
      rate = await client.rate.create({
        data: {
          tenantId: tenantId ?? null,
          rateCode: LOANER_RATE_CODE,
          name: 'Loaner Program Rates',
          purpose: 'LOANER',
        },
      });
    }
    return rate;
  },

  /** { [vehicleTypeId]: dailyRate } for the tenant's loaner price book (empty if none set). */
  async getLoanerRateMap(tenantId) {
    const rate = await prisma.rate.findFirst({
      where: { tenantId: tenantId ?? null, purpose: 'LOANER' },
      include: { rateItems: { select: { vehicleTypeId: true, daily: true } } },
    });
    const map = {};
    for (const it of rate?.rateItems || []) map[it.vehicleTypeId] = Number(it.daily || 0);
    return map;
  },

  /** Single class loaner daily rate (number) or null if unset. */
  async getLoanerClassRate(tenantId, vehicleTypeId) {
    if (!vehicleTypeId) return null;
    const map = await this.getLoanerRateMap(tenantId);
    return Object.prototype.hasOwnProperty.call(map, vehicleTypeId) ? map[vehicleTypeId] : null;
  },

  /** Admin grid: every vehicle type for the tenant + its loaner daily rate (null = unset = covered/$0). */
  async listForAdmin(scope = {}) {
    const tenantId = scope?.tenantId ?? null;
    const [types, map] = await Promise.all([
      prisma.vehicleType.findMany({
        where: { ...(tenantId ? { tenantId } : {}) },
        orderBy: [{ name: 'asc' }],
        select: { id: true, code: true, name: true },
      }),
      this.getLoanerRateMap(tenantId),
    ]);
    return {
      rates: types.map((t) => ({
        vehicleTypeId: t.id,
        code: t.code,
        name: t.name,
        dailyRate: Object.prototype.hasOwnProperty.call(map, t.id) ? map[t.id] : null,
      })),
    };
  },

  /** Upsert the loaner daily rate for one-or-more classes. items: [{vehicleTypeId, dailyRate}]. */
  async upsertRates(scope = {}, items = []) {
    const tenantId = scope?.tenantId ?? null;
    const rows = Array.isArray(items) ? items.filter((i) => i && i.vehicleTypeId) : [];
    if (!rows.length) return this.listForAdmin(scope);
    // Guard: only classes that belong to this tenant.
    const owned = await prisma.vehicleType.findMany({
      where: { id: { in: rows.map((r) => r.vehicleTypeId) }, ...(tenantId ? { tenantId } : {}) },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((o) => o.id));
    const rate = await this.getOrCreateLoanerRate(tenantId);
    for (const r of rows) {
      if (!ownedIds.has(r.vehicleTypeId)) continue;
      const daily = num(r.dailyRate);
      await prisma.rateItem.upsert({
        where: { rateId_vehicleTypeId: { rateId: rate.id, vehicleTypeId: r.vehicleTypeId } },
        update: { daily },
        create: { rateId: rate.id, vehicleTypeId: r.vehicleTypeId, daily },
      });
    }
    return this.listForAdmin(scope);
  },
};
