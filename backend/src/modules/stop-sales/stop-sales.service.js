import { prisma } from '../../lib/prisma.js';
import { toDate, isStopSaleOverlapping } from './stop-sale-overlap.js';

function normalizeDateRange({ startDate, endDate }) {
  const start = toDate(startDate);
  const end = toDate(endDate);
  if (!start || !end) throw new Error('startDate and endDate are required and must be valid dates');
  if (start >= end) throw new Error('endDate must be after startDate');
  return { start, end };
}

function scopedWhere(id, scope = {}) {
  return { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) };
}

const vehicleTypeInclude = {
  vehicleType: { select: { id: true, code: true, name: true } }
};

export const stopSalesService = {
  async list(scope = {}) {
    return prisma.vehicleClassStopSale.findMany({
      where: scope?.tenantId ? { tenantId: scope.tenantId } : {},
      include: vehicleTypeInclude,
      orderBy: [{ isActive: 'desc' }, { startDate: 'asc' }]
    });
  },

  async getById(id, scope = {}) {
    return prisma.vehicleClassStopSale.findFirst({
      where: scopedWhere(id, scope),
      include: vehicleTypeInclude
    });
  },

  async create(data, scope = {}) {
    const tenantId = scope?.tenantId || data?.tenantId;
    if (!tenantId) throw new Error('tenantId is required');
    if (!data?.vehicleTypeId) throw new Error('vehicleTypeId is required');
    const { start, end } = normalizeDateRange(data);
    // Cross-tenant defense: make sure the vehicle type belongs to this tenant.
    const vt = await prisma.vehicleType.findFirst({
      where: { id: data.vehicleTypeId, tenantId },
      select: { id: true }
    });
    if (!vt) throw new Error('Vehicle type not found for this tenant');
    return prisma.vehicleClassStopSale.create({
      data: {
        tenantId,
        vehicleTypeId: data.vehicleTypeId,
        startDate: start,
        endDate: end,
        reason: data.reason || null,
        notes: data.notes || null,
        isActive: data.isActive ?? true
      },
      include: vehicleTypeInclude
    });
  },

  async update(id, patch, scope = {}) {
    const current = await prisma.vehicleClassStopSale.findFirst({
      where: scopedWhere(id, scope),
      select: { id: true, startDate: true, endDate: true, tenantId: true }
    });
    if (!current) throw new Error('Stop sale not found');
    const data = { ...(patch || {}) };
    delete data.tenantId; // never rewrite tenant
    if (data.vehicleTypeId) {
      const vt = await prisma.vehicleType.findFirst({
        where: { id: data.vehicleTypeId, tenantId: current.tenantId },
        select: { id: true }
      });
      if (!vt) throw new Error('Vehicle type not found for this tenant');
    }
    if (data.startDate || data.endDate) {
      const startDate = toDate(data.startDate) || current.startDate;
      const endDate = toDate(data.endDate) || current.endDate;
      if (startDate >= endDate) throw new Error('endDate must be after startDate');
      data.startDate = startDate;
      data.endDate = endDate;
    }
    return prisma.vehicleClassStopSale.update({
      where: { id },
      data,
      include: vehicleTypeInclude
    });
  },

  async remove(id, scope = {}) {
    const current = await prisma.vehicleClassStopSale.findFirst({
      where: scopedWhere(id, scope),
      select: { id: true }
    });
    if (!current) throw new Error('Stop sale not found');
    return prisma.vehicleClassStopSale.delete({ where: { id } });
  },

  /**
   * Return a Set of vehicleTypeIds that have at least one active stop-sale
   * overlapping the requested [pickupAt, returnAt] range for the given tenant.
   *
   * Used by the public booking availability path (booking-engine searchRental)
   * to hide those classes from the website while leaving the backoffice and
   * per-VIN VehicleAvailabilityBlock filters untouched.
   *
   * Overlap semantics: half-open intervals. A stop-sale [S, E) overlaps a
   * requested rental [P, R) iff S < R AND E > P.
   */
  async vehicleTypesBlockedForRange({ tenantId, vehicleTypeIds, pickupAt, returnAt }) {
    if (!tenantId || !Array.isArray(vehicleTypeIds) || !vehicleTypeIds.length) return new Set();
    const pickupDate = toDate(pickupAt);
    const returnDate = toDate(returnAt);
    if (!pickupDate || !returnDate || pickupDate >= returnDate) return new Set();
    const active = await prisma.vehicleClassStopSale.findMany({
      where: {
        tenantId,
        vehicleTypeId: { in: vehicleTypeIds },
        isActive: true,
        startDate: { lt: returnDate },
        endDate: { gt: pickupDate }
      },
      select: { vehicleTypeId: true }
    });
    return new Set(active.map((row) => row.vehicleTypeId));
  }
};

// Re-export the pure helper so existing callers can still reach it here.
export { isStopSaleOverlapping };
