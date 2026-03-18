import { prisma } from '../../lib/prisma.js';

function normalizeScope(scope = {}) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : {};
}

function normalizeDecimal(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function monthKey(value = new Date()) {
  const d = new Date(value);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export const commissionsService = {
  listPlans(scope = {}) {
    return prisma.commissionPlan.findMany({
      where: normalizeScope(scope),
      include: {
        rules: {
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
          include: { service: true }
        }
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }]
    });
  },

  getPlan(id, scope = {}) {
    return prisma.commissionPlan.findFirst({
      where: { id, ...normalizeScope(scope) },
      include: {
        rules: {
          orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
          include: { service: true }
        }
      }
    });
  },

  createPlan(data = {}, scope = {}) {
    return prisma.commissionPlan.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        name: String(data.name || '').trim(),
        isActive: data.isActive ?? true,
        defaultValueType: data.defaultValueType || null,
        defaultPercentValue: normalizeDecimal(data.defaultPercentValue),
        defaultFixedAmount: normalizeDecimal(data.defaultFixedAmount)
      }
    });
  },

  async updatePlan(id, patch = {}, scope = {}) {
    const current = await prisma.commissionPlan.findFirst({
      where: { id, ...normalizeScope(scope) },
      select: { id: true }
    });
    if (!current) throw new Error('Commission plan not found');

    const data = { ...patch };
    delete data.tenantId;

    return prisma.commissionPlan.update({
      where: { id },
      data: {
        ...data,
        defaultPercentValue: patch.defaultPercentValue !== undefined ? normalizeDecimal(patch.defaultPercentValue) : undefined,
        defaultFixedAmount: patch.defaultFixedAmount !== undefined ? normalizeDecimal(patch.defaultFixedAmount) : undefined
      }
    });
  },

  async removePlan(id, scope = {}) {
    const current = await prisma.commissionPlan.findFirst({
      where: { id, ...normalizeScope(scope) },
      select: { id: true }
    });
    if (!current) throw new Error('Commission plan not found');
    return prisma.commissionPlan.delete({ where: { id } });
  },

  async listRules(planId, scope = {}) {
    const plan = await prisma.commissionPlan.findFirst({
      where: { id: planId, ...normalizeScope(scope) },
      select: { id: true }
    });
    if (!plan) throw new Error('Commission plan not found');

    return prisma.commissionRule.findMany({
      where: { commissionPlanId: planId },
      include: { service: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }]
    });
  },

  async createRule(planId, data = {}, scope = {}) {
    const plan = await prisma.commissionPlan.findFirst({
      where: { id: planId, ...normalizeScope(scope) },
      select: { id: true, tenantId: true }
    });
    if (!plan) throw new Error('Commission plan not found');

    return prisma.commissionRule.create({
      data: {
        commissionPlanId: planId,
        tenantId: plan.tenantId || null,
        name: String(data.name || '').trim(),
        serviceId: data.serviceId || null,
        chargeCode: data.chargeCode ? String(data.chargeCode).trim() : null,
        chargeType: data.chargeType || null,
        valueType: data.valueType,
        percentValue: normalizeDecimal(data.percentValue),
        fixedAmount: normalizeDecimal(data.fixedAmount),
        priority: Number.isInteger(data.priority) ? data.priority : Number(data.priority || 0),
        isActive: data.isActive ?? true
      },
      include: { service: true }
    });
  },

  async updateRule(id, patch = {}, scope = {}) {
    const current = await prisma.commissionRule.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!current) throw new Error('Commission rule not found');

    const data = { ...patch };
    delete data.tenantId;
    delete data.commissionPlanId;

    return prisma.commissionRule.update({
      where: { id },
      data: {
        ...data,
        serviceId: patch.serviceId === '' ? null : patch.serviceId,
        chargeCode: patch.chargeCode === '' ? null : patch.chargeCode,
        chargeType: patch.chargeType === '' ? null : patch.chargeType,
        percentValue: patch.percentValue !== undefined ? normalizeDecimal(patch.percentValue) : undefined,
        fixedAmount: patch.fixedAmount !== undefined ? normalizeDecimal(patch.fixedAmount) : undefined,
        priority: patch.priority !== undefined ? (Number.isInteger(patch.priority) ? patch.priority : Number(patch.priority || 0)) : undefined
      },
      include: { service: true }
    });
  },

  async removeRule(id, scope = {}) {
    const current = await prisma.commissionRule.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true }
    });
    if (!current) throw new Error('Commission rule not found');
    return prisma.commissionRule.delete({ where: { id } });
  },

  async ledger(query = {}, scope = {}) {
    const start = query?.start ? new Date(query.start) : null;
    const end = query?.end ? new Date(query.end) : null;
    const employeeUserId = query?.employeeUserId ? String(query.employeeUserId) : null;
    const month = query?.month ? String(query.month) : monthKey(new Date());

    const where = {
      ...normalizeScope(scope),
      ...(employeeUserId ? { employeeUserId } : {}),
      ...(start || end
        ? {
            calculatedAt: {
              ...(start && !Number.isNaN(start.getTime()) ? { gte: start } : {}),
              ...(end && !Number.isNaN(end.getTime()) ? { lte: end } : {})
            }
          }
        : { monthKey: month })
    };

    return prisma.agreementCommission.findMany({
      where,
      include: {
        employeeUser: { select: { id: true, fullName: true, email: true, role: true } },
        rentalAgreement: { select: { id: true, agreementNumber: true, reservationId: true, closedAt: true, total: true } },
        lines: {
          include: { service: { select: { id: true, name: true, code: true } } },
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: [{ calculatedAt: 'desc' }, { createdAt: 'desc' }]
    });
  }
};
