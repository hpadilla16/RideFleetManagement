import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';

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

export const locationsService = {
  list(scope = {}) {
    return cache.getOrSet(listCacheKey(scope), () => prisma.location.findMany({
      where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
      orderBy: { name: 'asc' },
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
