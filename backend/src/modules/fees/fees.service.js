import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';

// Reference data; rarely changes. 5-min TTL with active invalidation on writes.
const LIST_TTL_MS = 5 * 60 * 1000;
function listCacheKey(scope = {}) {
  return `fees:list:${scope?.tenantId || 'global'}`;
}
function invalidateListCache(scope = {}) {
  cache.del(listCacheKey(scope));
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
    invalidateListCache(scope);
    // Locations include fees in their nested response — invalidate them too.
    cache.invalidate('locations:list:');
    return out;
  },
  async update(id, patch, scope = {}) {
    const current = await prisma.fee.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Fee not found');
    const data = { ...(patch || {}) };
    delete data.tenantId;
    const out = await prisma.fee.update({ where: { id }, data });
    invalidateListCache(scope);
    cache.invalidate('locations:list:');
    return out;
  },
  async remove(id, scope = {}) {
    const current = await prisma.fee.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Fee not found');
    const out = await prisma.fee.delete({ where: { id } });
    invalidateListCache(scope);
    cache.invalidate('locations:list:');
    return out;
  }
};
