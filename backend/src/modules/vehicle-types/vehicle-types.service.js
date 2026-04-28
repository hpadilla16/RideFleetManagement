import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';

// Reference data; rarely changes. 5-min TTL with active invalidation on writes.
const LIST_TTL_MS = 5 * 60 * 1000;
function listCacheKey(scope = {}) {
  return `vehicle-types:list:${scope?.tenantId || 'global'}`;
}
function invalidateListCache(scope = {}) {
  cache.del(listCacheKey(scope));
}

export const vehicleTypesService = {
  list(scope = {}) {
    return cache.getOrSet(
      listCacheKey(scope),
      () => prisma.vehicleType.findMany({ where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined, orderBy: { name: 'asc' } }),
      LIST_TTL_MS
    );
  },
  getById(id, scope = {}) {
    return prisma.vehicleType.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
  },
  async create(data, scope = {}) {
    const out = await prisma.vehicleType.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        code: data.code,
        name: data.name,
        description: data.description ?? null,
        imageUrl: data.imageUrl ?? null
      }
    });
    invalidateListCache(scope);
    return out;
  },
  async update(id, patch, scope = {}) {
    const current = await prisma.vehicleType.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Vehicle type not found');
    const data = { ...(patch || {}) };
    delete data.tenantId;
    const out = await prisma.vehicleType.update({ where: { id }, data });
    invalidateListCache(scope);
    return out;
  },
  async remove(id, scope = {}) {
    const current = await prisma.vehicleType.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Vehicle type not found');
    const out = await prisma.vehicleType.delete({ where: { id } });
    invalidateListCache(scope);
    return out;
  }
};
