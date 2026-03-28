import { prisma } from '../../lib/prisma.js';

export const additionalServicesService = {
  list({ locationId, activeOnly = false, tenantId } = {}) {
    return prisma.additionalService.findMany({
      where: {
        ...(tenantId ? { tenantId } : {}),
        ...(locationId ? { OR: [{ locationId }, { locationId: null }] } : {}),
        isActive: activeOnly ? true : undefined
      },
      include: { location: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });
  },

  getById(id, scope = {}) {
    return prisma.additionalService.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, include: { location: true } });
  },

  create(data, scope = {}) {
    return prisma.additionalService.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        code: data.code ?? null,
        name: data.name,
        description: data.description ?? null,
        chargeType: data.chargeType ?? 'UNIT',
        unitLabel: data.unitLabel ?? 'Unit',
        calculationBy: data.calculationBy ?? '24_HOUR_TIME',
        rate: data.rate ?? 0,
        dailyRate: data.dailyRate ?? null,
        weeklyRate: data.weeklyRate ?? null,
        monthlyRate: data.monthlyRate ?? null,
        commissionValueType: data.commissionValueType || null,
        commissionPercentValue: data.commissionPercentValue ?? null,
        commissionFixedAmount: data.commissionFixedAmount ?? null,
        taxable: data.taxable ?? false,
        defaultQty: data.defaultQty ?? 1,
        sortOrder: data.sortOrder ?? 0,
        allVehicleTypes: data.allVehicleTypes ?? true,
        vehicleTypeIds: data.vehicleTypeIds ?? null,
        displayOnline: data.displayOnline ?? false,
        defaultRencars: data.defaultRencars ?? false,
        mandatory: data.mandatory ?? false,
        coversTolls: data.coversTolls ?? false,
        isActive: data.isActive ?? true,
        locationId: data.locationId || null
      },
      include: { location: true }
    });
  },

  async update(id, patch, scope = {}) {
    const current = await prisma.additionalService.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Additional service not found');
    const data = { ...(patch || {}) };
    delete data.tenantId;
    return prisma.additionalService.update({
      where: { id },
      data: {
        ...data,
        locationId: data.locationId === '' ? null : data.locationId,
        commissionValueType: data.commissionValueType === '' ? null : data.commissionValueType,
        commissionPercentValue: Object.prototype.hasOwnProperty.call(data, 'commissionPercentValue') && (data.commissionPercentValue === '' || data.commissionPercentValue === null) ? null : data.commissionPercentValue,
        commissionFixedAmount: Object.prototype.hasOwnProperty.call(data, 'commissionFixedAmount') && (data.commissionFixedAmount === '' || data.commissionFixedAmount === null) ? null : data.commissionFixedAmount
      },
      include: { location: true }
    });
  },

  async remove(id, scope = {}) {
    const current = await prisma.additionalService.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Additional service not found');
    return prisma.additionalService.delete({ where: { id } });
  }
};
