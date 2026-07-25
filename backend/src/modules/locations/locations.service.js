import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { scopeAllowedLocationIds } from '../../lib/tenant-scope.js';

// 5-minute TTL on tenant-scoped location list. Locations change rarely;
// staff opening multiple reservations in a row should hit cache. Writes
// invalidate by the WRITTEN ROW's effective tenantId, not the request scope —
// SUPER_ADMIN can write into a specific tenant via data.tenantId without
// `?tenantId=` in the request, which would otherwise leave the per-tenant
// cache stale. See invalidateListCacheForTenant below.
const LIST_TTL_MS = 5 * 60 * 1000;
function listCacheKey(scope = {}) {
  return `locations:list:${scope?.tenantId || 'global'}`;
}
function invalidateListCacheForTenant(effectiveTenantId) {
  // Per-tenant (or global if null) bucket the row lives in.
  cache.del(listCacheKey({ tenantId: effectiveTenantId || null }));
  // The unfiltered SUPER_ADMIN list (`locations:list:global`) returns rows
  // from ALL tenants — any tenant-scoped write makes it stale too.
  if (effectiveTenantId) cache.del('locations:list:global');
}

// The three Terms & Conditions columns on Location are DOCUMENTS — the canonical
// agreement they replace or extend is ~70 KB. This list is cached in process and
// is also reached through /api/reservations/create-options and
// /api/reservations/:id/pricing-options, which cache again, so letting them ride
// along multiplies a full contract by (locations × cached reservations) for
// screens that only ever need a name and a code.
//
// `omit` rather than an explicit `select`: this row's fields are consumed all
// over the app and by the location editor, so an allow-list would silently drop
// whatever it forgot. A deny-list can only ever remove these three. Anything that
// genuinely needs the terms reads them through getEffectiveTermsHtml or getById.
const LIST_OMIT = { termsHtml: true, termsRiderHtml: true, termsSectionsJson: true };

export const locationsService = {
  list(scope = {}) {
    return cache.getOrSet(listCacheKey(scope), () => prisma.location.findMany({
      where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
      orderBy: { name: 'asc' },
      omit: LIST_OMIT,
      include: { locationFees: { include: { fee: true } } }
    }), LIST_TTL_MS);
  },
  getById(id, scope = {}) {
    return prisma.location.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: { locationFees: { include: { fee: true } } }
    });
  },
  async create(data, scope = {}) {
    const out = await prisma.location.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        code: data.code,
        name: data.name,
        address: data.address ?? null,
        city: data.city ?? null,
        state: data.state ?? null,
        country: data.country ?? null,
        isActive: data.isActive ?? true,
        locationConfig: data.locationConfig
          ? (typeof data.locationConfig === 'string' ? data.locationConfig : JSON.stringify(data.locationConfig))
          : null
      }
    });
    invalidateListCacheForTenant(out.tenantId);
    return out;
  },
  async update(id, patch, scope = {}) {
    // Location scoping (2026-07-24). This used to filter by tenantId alone, so
    // a branch-restricted ADMIN — a role that has existed since beta.338 — could
    // PATCH ANY location in the tenant. That was already wrong for taxRate and
    // locationConfig; it became sharper once `termsHtml` landed on this row,
    // because that field REPLACES the entire rental agreement body for the
    // branch. A LAX admin must not be able to rewrite Orlando's contract.
    // Checked BEFORE the query, not spread into the `where`: a second `id` key
    // in that object silently overwrites the first, which would have matched
    // any allowed location instead of the requested one.
    const allowed = scopeAllowedLocationIds(scope);
    if (allowed && !allowed.includes(String(id))) throw new Error('Location not found');
    const current = await prisma.location.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true, tenantId: true }
    });
    if (!current) throw new Error('Location not found');
    const { feeIds, ...rest } = patch || {};
    delete rest.tenantId;
    if (Object.prototype.hasOwnProperty.call(rest, 'locationConfig')) {
      rest.locationConfig = rest.locationConfig
        ? (typeof rest.locationConfig === 'string' ? rest.locationConfig : JSON.stringify(rest.locationConfig))
        : null;
    }

    if (Array.isArray(feeIds)) {
      await prisma.$transaction(async (tx) => {
        await tx.location.update({ where: { id }, data: rest });
        await tx.locationFee.deleteMany({ where: { locationId: id } });
        if (feeIds.length) {
          await tx.locationFee.createMany({ data: feeIds.map((feeId) => ({ locationId: id, feeId })) });
        }
      });
      invalidateListCacheForTenant(current.tenantId);
      return this.getById(id);
    }

    const out = await prisma.location.update({ where: { id }, data: rest, include: { locationFees: { include: { fee: true } } } });
    invalidateListCacheForTenant(current.tenantId);
    return out;
  },
  async remove(id, scope = {}) {
    const current = await prisma.location.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true, tenantId: true }
    });
    if (!current) throw new Error('Location not found');
    const out = await prisma.location.delete({ where: { id } });
    invalidateListCacheForTenant(current.tenantId);
    return out;
  }
};
