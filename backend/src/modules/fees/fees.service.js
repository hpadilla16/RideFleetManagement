import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';

// Reference data; rarely changes. 5-min TTL with active invalidation on writes.
//
// Cache invalidation correctness — see comments in invalidateListCacheForTenant
// below. We always invalidate by the WRITTEN ROW's effective tenantId, never by
// the request scope alone. SUPER_ADMIN can write into a specific tenant via
// data.tenantId without `?tenantId=` in the request; if we keyed invalidation
// off `scope` only, the per-tenant cache would stay stale for up to TTL.
const LIST_TTL_MS = 5 * 60 * 1000;
function listCacheKey(scope = {}) {
  return `fees:list:${scope?.tenantId || 'global'}`;
}
function invalidateListCacheForTenant(effectiveTenantId) {
  // Clear the bucket the row actually lives in. If tenantId is null (truly
  // global fee), this clears `fees:list:global` which is the unfiltered
  // SUPER_ADMIN list. If tenantId is set, this clears the per-tenant bucket.
  cache.del(listCacheKey({ tenantId: effectiveTenantId || null }));
  // The unfiltered SUPER_ADMIN list (`fees:list:global`) returns rows from
  // ALL tenants because findMany was called with `where: undefined`. Any
  // tenant-scoped write therefore also makes it stale; clear it too.
  if (effectiveTenantId) cache.del('fees:list:global');
  // Locations include nested fee data in their list response — invalidate
  // every tenant's locations:list bucket. Cheap; locations writes are rare.
  cache.invalidate('locations:list:');
}

export const feesService = {
  list(scope = {}) {
    return cache.getOrSet(
      listCacheKey(scope),
      () => prisma.fee.findMany({ where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }),
      LIST_TTL_MS
    );
  },
  getById(id, scope = {}) {
    return prisma.fee.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
  },
  async create(data, scope = {}) {
    const out = await prisma.fee.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        code: data.code ?? null,
        name: data.name,
        description: data.description ?? null,
        mode: data.mode,
        amount: data.amount ?? 0,
        taxable: data.taxable ?? false,
        isActive: data.isActive ?? true,
        mandatory: data.mandatory ?? false,
        isUnderageFee: data.isUnderageFee ?? false,
        isAdditionalDriverFee: data.isAdditionalDriverFee ?? false,
        displayOnline: data.displayOnline ?? false
      }
    });
    invalidateListCacheForTenant(out.tenantId);
    return out;
  },
  async update(id, patch, scope = {}) {
    const current = await prisma.fee.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true, tenantId: true }
    });
    if (!current) throw new Error('Fee not found');
    const data = { ...(patch || {}) };
    delete data.tenantId;
    const out = await prisma.fee.update({ where: { id }, data });
    invalidateListCacheForTenant(current.tenantId);
    return out;
  },
  async remove(id, scope = {}) {
    const current = await prisma.fee.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true, tenantId: true }
    });
    if (!current) throw new Error('Fee not found');
    const out = await prisma.fee.delete({ where: { id } });
    invalidateListCacheForTenant(current.tenantId);
    return out;
  }
};
