import { prisma } from '../../lib/prisma.js';

function norm(v) {
  return String(v || '').trim();
}

function keyset(rows, key) {
  return new Set(rows.map((r) => norm(r[key]).toLowerCase()).filter(Boolean));
}

function byTenantWhere(scope = {}) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : undefined;
}

function uniqueBy(items = [], getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const vehiclesService = {
  list(scope = {}) {
    return prisma.vehicle.findMany({
      where: byTenantWhere(scope),
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
      where: { id, ...(byTenantWhere(scope) || {}) },
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
    const current = await prisma.vehicle.findFirst({ where: { id, ...(byTenantWhere(scope) || {}) }, select: { id: true } });
    if (!current) throw new Error('Vehicle not found');
    const data = { ...(patch || {}) };
    if (!scope?.allowCrossTenant) delete data.tenantId;
    return prisma.vehicle.update({ where: { id }, data });
  },

  async remove(id, scope = {}) {
    const current = await prisma.vehicle.findFirst({ where: { id, ...(byTenantWhere(scope) || {}) }, select: { id: true } });
    if (!current) throw new Error('Vehicle not found');
    return prisma.vehicle.delete({ where: { id } });
  },

  async validateBulk(rows = [], scope = {}) {
    const existing = await prisma.vehicle.findMany({
      where: byTenantWhere(scope),
      select: { internalNumber: true, vin: true, plate: true }
    });
    const vehicleTypes = await prisma.vehicleType.findMany({
      where: byTenantWhere(scope),
      select: { id: true, code: true, name: true, tenantId: true }
    });

    const existingInternal = keyset(existing, 'internalNumber');
    const existingVin = keyset(existing, 'vin');
    const existingPlate = keyset(existing, 'plate');
    const vehicleTypeById = new Map(vehicleTypes.map((row) => [String(row.id), row]));
    const vehicleTypesByCode = new Map();
    const vehicleTypesByName = new Map();
    vehicleTypes.forEach((row) => {
      const codeKey = norm(row.code).toUpperCase();
      const nameKey = norm(row.name).toLowerCase();
      if (codeKey) vehicleTypesByCode.set(codeKey, [...(vehicleTypesByCode.get(codeKey) || []), row]);
      if (nameKey) vehicleTypesByName.set(nameKey, [...(vehicleTypesByName.get(nameKey) || []), row]);
    });

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
      const vehicleTypeCode = norm(r.vehicleTypeCode);
      const vehicleTypeName = norm(r.vehicleTypeName || r.vehicleType);

      const errors = [];
      if (!internalNumber) errors.push('internalNumber required');

      let resolvedVehicleType = null;
      if (vehicleTypeId) {
        resolvedVehicleType = vehicleTypeById.get(vehicleTypeId) || null;
        if (!resolvedVehicleType) errors.push('vehicleTypeId not found');
      } else if (vehicleTypeCode) {
        const matches = uniqueBy(vehicleTypesByCode.get(vehicleTypeCode.toUpperCase()) || [], (row) => row.id);
        if (matches.length === 1) resolvedVehicleType = matches[0];
        else if (matches.length > 1) errors.push(`vehicleTypeCode ${vehicleTypeCode} is ambiguous`);
        else errors.push(`vehicleTypeCode ${vehicleTypeCode} not found`);
      } else if (vehicleTypeName) {
        const matches = uniqueBy(vehicleTypesByName.get(vehicleTypeName.toLowerCase()) || [], (row) => row.id);
        if (matches.length === 1) resolvedVehicleType = matches[0];
        else if (matches.length > 1) errors.push(`vehicleType ${vehicleTypeName} is ambiguous`);
        else errors.push(`vehicleType ${vehicleTypeName} not found`);
      } else {
        errors.push('vehicleTypeCode or vehicleType required');
      }

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
        vehicleTypeId: resolvedVehicleType?.id || vehicleTypeId,
        vehicleTypeCode: resolvedVehicleType?.code || vehicleTypeCode,
        vehicleTypeName: resolvedVehicleType?.name || vehicleTypeName,
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
