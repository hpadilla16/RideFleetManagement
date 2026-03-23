import { prisma } from '../../lib/prisma.js';

export const vehicleTypesService = {
  list(scope = {}) {
    return prisma.vehicleType.findMany({ where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined, orderBy: { name: 'asc' } });
  },
  getById(id, scope = {}) {
    return prisma.vehicleType.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
  },
  create(data, scope = {}) {
    return prisma.vehicleType.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        code: data.code,
        name: data.name,
        description: data.description ?? null,
        imageUrl: data.imageUrl ?? null
      }
    });
  },
  async update(id, patch, scope = {}) {
    const current = await prisma.vehicleType.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Vehicle type not found');
    const data = { ...(patch || {}) };
    delete data.tenantId;
    return prisma.vehicleType.update({ where: { id }, data });
  },
  async remove(id, scope = {}) {
    const current = await prisma.vehicleType.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Vehicle type not found');
    return prisma.vehicleType.delete({ where: { id } });
  }
};
