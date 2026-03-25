import { prisma } from '../../lib/prisma.js';

function norm(v) {
  return String(v || '').trim();
}

function keyset(rows, key) {
  return new Set(rows.map((r) => norm(r[key]).toLowerCase()).filter(Boolean));
}

export const vehiclesService = {
  list(scope = {}) {
    return prisma.vehicle.findMany({
      where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        tenant: true,
        vehicleType: true,
        homeLocation: true,
        rentalAgreements: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            agreementNumber: true,
            createdAt: true,
            inspections: { select: { phase: true, capturedAt: true } },
            reservation: { select: { reservationNumber: true, customer: { select: { firstName: true, lastName: true } } } }
          }
        }
      }
    });
  },

  getById(id, scope = {}) {
    return prisma.vehicle.findFirst({
      where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      include: {
        tenant: true,
        vehicleType: true,
        homeLocation: true,
        rentalAgreements: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            agreementNumber: true,
            createdAt: true,
            inspections: { select: { phase: true, capturedAt: true } },
            reservation: { select: { reservationNumber: true, customer: { select: { firstName: true, lastName: true } } } }
          }
        }
      }
    });
  },

  create(data, scope = {}) {
    return prisma.vehicle.create({
      data: {
        tenantId: scope?.allowCrossTenant ? (data.tenantId || null) : (scope?.tenantId || data.tenantId || null),
        internalNumber: data.internalNumber,
        vin: data.vin ?? null,
        plate: data.plate ?? null,
        tollTagNumber: data.tollTagNumber ?? null,
        tollStickerNumber: data.tollStickerNumber ?? null,
        make: data.make ?? null,
        model: data.model ?? null,
        year: data.year ?? null,
        color: data.color ?? null,
        mileage: data.mileage ?? 0,
        status: data.status ?? 'AVAILABLE',
        fleetMode: data.fleetMode ?? 'RENTAL_ONLY',
        vehicleTypeId: data.vehicleTypeId,
        homeLocationId: data.homeLocationId ?? null
      }
    });
  },

  async update(id, patch, scope = {}) {
    const current = await prisma.vehicle.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Vehicle not found');
    const data = { ...(patch || {}) };
    if (!scope?.allowCrossTenant) delete data.tenantId;
    return prisma.vehicle.update({ where: { id }, data });
  },

  async remove(id, scope = {}) {
    const current = await prisma.vehicle.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { id: true } });
    if (!current) throw new Error('Vehicle not found');
    return prisma.vehicle.delete({ where: { id } });
  },

  async validateBulk(rows = [], scope = {}) {
    const existing = await prisma.vehicle.findMany({
      where: scope?.tenantId ? { tenantId: scope.tenantId } : undefined,
      select: { internalNumber: true, vin: true, plate: true }
    });

    const existingInternal = keyset(existing, 'internalNumber');
    const existingVin = keyset(existing, 'vin');
    const existingPlate = keyset(existing, 'plate');

    let validCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;

    const report = rows.map((r, idx) => {
      const internalNumber = norm(r.internalNumber);
      const make = norm(r.make);
      const model = norm(r.model);
      const color = norm(r.color);
      const vin = norm(r.vin);
      const plate = norm(r.plate);
      const tollTagNumber = norm(r.tollTagNumber);
      const tollStickerNumber = norm(r.tollStickerNumber);
      const vehicleTypeId = norm(r.vehicleTypeId);

      const errors = [];
      if (!internalNumber) errors.push('internalNumber required');
      if (!vehicleTypeId) errors.push('vehicleTypeId required');

      const dupReasons = [];
      if (existingInternal.has(internalNumber.toLowerCase())) dupReasons.push('internalNumber exists');
      if (vin && existingVin.has(vin.toLowerCase())) dupReasons.push('vin exists');
      if (plate && existingPlate.has(plate.toLowerCase())) dupReasons.push('plate exists');

      if (errors.length) invalidCount += 1;
      else if (dupReasons.length) duplicateCount += 1;
      else validCount += 1;

      return {
        row: idx + 1,
        internalNumber,
        make,
        model,
        color,
        vin,
        plate,
        tollTagNumber,
        tollStickerNumber,
        vehicleTypeId,
        valid: !errors.length && !dupReasons.length,
        errors,
        duplicateReasons: dupReasons
      };
    });

    return {
      found: rows.length,
      valid: validCount,
      duplicates: duplicateCount,
      invalid: invalidCount,
      rows: report
    };
  },

  async importBulk(rows = [], scope = {}) {
    const validation = await this.validateBulk(rows, scope);
    const validRows = validation.rows.filter((r) => r.valid);

    if (!validRows.length) {
      return { created: 0, skipped: validation.found, validation };
    }

    for (const r of validRows) {
      await prisma.vehicle.create({
        data: {
          tenantId: scope?.tenantId || null,
          internalNumber: r.internalNumber,
          vin: r.vin || null,
          plate: r.plate || null,
          tollTagNumber: r.tollTagNumber || null,
          tollStickerNumber: r.tollStickerNumber || null,
          make: r.make || null,
          model: r.model || null,
          color: r.color || null,
          mileage: 0,
          status: 'AVAILABLE',
          vehicleTypeId: r.vehicleTypeId
        }
      });
    }

    return {
      created: validRows.length,
      skipped: validation.found - validRows.length,
      validation
    };
  }
};
