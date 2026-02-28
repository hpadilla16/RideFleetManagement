import { prisma } from '../../lib/prisma.js';

export const feesService = {
  list(scope = {}) {
    return prisma.fee.findMany({ where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  },
  getById(id, scope = {}) {
    return prisma.fee.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
  },
  create(data, scope = {}) {
    return prisma.fee.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        code: data.code ?? null,
        name: data.name,
        description: data.description ?? null,
        mode: data.mode,
        amount: data.amount ?? 0,
        taxable: data.taxable ?? false,
        isActive: data.isActive ?? true,
        isUnderageFee: data.isUnderageFee ?? false,
        isAdditionalDriverFee: data.isAdditionalDriverFee ?? false
      }
    });
  },
  async update(id, patch, scope = {}) {
    const current = await prisma.fee.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Fee not found');
    const data = { ...(patch || {}) };
    delete data.tenantId;
    return prisma.fee.update({ where: { id }, data });
  },
  async remove(id, scope = {}) {
    const current = await prisma.fee.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Fee not found');
    return prisma.fee.delete({ where: { id } });
  }
};
