import { prisma } from '../../lib/prisma.js';

async function listWithLinkedFee(args) {
  try {
    return await prisma.additionalService.findMany({
      ...args,
      include: { location: true, linkedFee: true }
    });
  } catch {
    const rows = await prisma.additionalService.findMany({
      ...args,
      include: { location: true }
    });
    return rows.map((row) => ({ ...row, linkedFee: null }));
  }
}

async function firstWithLinkedFee(args) {
  try {
    return await prisma.additionalService.findFirst({
      ...args,
      include: { location: true, linkedFee: true }
    });
  } catch {
    const row = await prisma.additionalService.findFirst({
      ...args,
      include: { location: true }
    });
    return row ? { ...row, linkedFee: null } : null;
  }
}

async function createWithLinkedFee(data) {
  try {
    return await prisma.additionalService.create({
      data,
      include: { location: true, linkedFee: true }
    });
  } catch {
    const row = await prisma.additionalService.create({
      data,
      include: { location: true }
    });
    return { ...row, linkedFee: null };
  }
}

async function updateWithLinkedFee(id, data) {
  try {
    return await prisma.additionalService.update({
      where: { id },
      data,
      include: { location: true, linkedFee: true }
    });
  } catch {
    const row = await prisma.additionalService.update({
      where: { id },
      data,
      include: { location: true }
    });
    return { ...row, linkedFee: null };
  }
}

async function resolveScopedLinkedFeeId(linkedFeeId, scope = {}) {
  if (!linkedFeeId) return null;
  const fee = await prisma.fee.findFirst({
    where: {
      id: String(linkedFeeId),
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
    },
    select: { id: true }
  });
  if (!fee) throw new Error('Linked fee not found for this tenant');
  return fee.id;
}

export const additionalServicesService = {
  list({ locationId, activeOnly = false, tenantId } = {}) {
    return listWithLinkedFee({
      where: {
        ...(tenantId ? { tenantId } : {}),
        ...(locationId ? { OR: [{ locationId }, { locationId: null }] } : {}),
        isActive: activeOnly ? true : undefined
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
    });
  },

  getById(id, scope = {}) {
    return firstWithLinkedFee({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }
    });
  },

  async create(data, scope = {}) {
    const linkedFeeId = await resolveScopedLinkedFeeId(data.linkedFeeId || null, scope);
    return createWithLinkedFee({
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
      locationId: data.locationId || null,
      linkedFeeId
    });
  },

  async update(id, patch, scope = {}) {
    const current = await prisma.additionalService.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Additional service not found');
    const data = { ...(patch || {}) };
    delete data.tenantId;
    const linkedFeeId = Object.prototype.hasOwnProperty.call(data, 'linkedFeeId')
      ? await resolveScopedLinkedFeeId(data.linkedFeeId || null, scope)
      : undefined;
    return updateWithLinkedFee(id, {
      ...data,
      locationId: data.locationId === '' ? null : data.locationId,
      ...(linkedFeeId !== undefined ? { linkedFeeId } : {}),
      commissionValueType: data.commissionValueType === '' ? null : data.commissionValueType,
      commissionPercentValue: Object.prototype.hasOwnProperty.call(data, 'commissionPercentValue') && (data.commissionPercentValue === '' || data.commissionPercentValue === null) ? null : data.commissionPercentValue,
      commissionFixedAmount: Object.prototype.hasOwnProperty.call(data, 'commissionFixedAmount') && (data.commissionFixedAmount === '' || data.commissionFixedAmount === null) ? null : data.commissionFixedAmount
    });
  },

  async remove(id, scope = {}) {
    const current = await prisma.additionalService.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Additional service not found');
    return prisma.additionalService.delete({ where: { id } });
  }
};
