import { prisma } from '../../lib/prisma.js';

export const locationsService = {
  list(scope = {}) {
    return prisma.location.findMany({
      where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
      orderBy: { name: 'asc' },
      include: { locationFees: { include: { fee: true } } }
    });
  },
  getById(id, scope = {}) {
    return prisma.location.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: { locationFees: { include: { fee: true } } }
    });
  },
  create(data, scope = {}) {
    return prisma.location.create({
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
  },
  async update(id, patch, scope = {}) {
    const current = await prisma.location.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
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
      return this.getById(id);
    }

    return prisma.location.update({ where: { id }, data: rest, include: { locationFees: { include: { fee: true } } } });
  },
  async remove(id, scope = {}) {
    const current = await prisma.location.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Location not found');
    return prisma.location.delete({ where: { id } });
  }
};
