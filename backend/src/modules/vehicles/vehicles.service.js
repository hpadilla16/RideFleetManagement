import { prisma } from '../../lib/prisma.js';
import { normalizeVehicleBlockType } from './vehicle-blocks.js';

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

function activeBlockWhere(now = new Date()) {
  return {
    releasedAt: null,
    blockedFrom: { lte: now },
    availableFrom: { gt: now }
  };
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeBlockRow(row = {}) {
  const blockType = normalizeVehicleBlockType(row.blockType || row.type || row.holdType);
  return {
    blockType,
    blockedFrom: toDateOrNull(row.blockedFrom) || new Date(),
    availableFrom: toDateOrNull(row.availableFrom),
    reason: norm(row.reason) || null,
    notes: norm(row.notes) || null
  };
}

const vehicleReservationSelect = {
  id: true,
  reservationNumber: true,
  status: true,
  workflowMode: true,
  pickupAt: true,
  returnAt: true,
  notes: true,
  pickupLocation: { select: { id: true, name: true, code: true } },
  returnLocation: { select: { id: true, name: true, code: true } },
  customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
  rentalAgreement: {
    select: {
      id: true,
      agreementNumber: true,
      status: true,
      balance: true,
      finalizedAt: true,
      closedAt: true,
      inspections: {
        orderBy: { capturedAt: 'desc' },
        select: { phase: true, capturedAt: true }
      }
    }
  }
};

export const vehiclesService = {
  list(scope = {}) {
    return prisma.vehicle.findMany({
      where: byTenantWhere(scope),
      orderBy: { createdAt: 'desc' },
      include: {
        tenant: true,
        vehicleType: true,
        homeLocation: true,
        availabilityBlocks: {
          where: { releasedAt: null },
          orderBy: [{ blockedFrom: 'asc' }, { availableFrom: 'asc' }]
        },
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

  async getById(id, scope = {}) {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id, ...(byTenantWhere(scope) || {}) },
      include: {
        tenant: true,
        vehicleType: true,
        homeLocation: true,
        availabilityBlocks: {
          where: { releasedAt: null },
          orderBy: [{ blockedFrom: 'asc' }, { availableFrom: 'asc' }]
        },
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
    if (!vehicle) return null;

    const reservationWhere = {
      vehicleId: vehicle.id,
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
    };
    const now = new Date();
    const [activeReservation, nextReservation, recentReservations] = await Promise.all([
      prisma.reservation.findFirst({
        where: {
          ...reservationWhere,
          status: 'CHECKED_OUT'
        },
        orderBy: [{ returnAt: 'asc' }, { pickupAt: 'asc' }],
        select: vehicleReservationSelect
      }),
      prisma.reservation.findFirst({
        where: {
          ...reservationWhere,
          status: { in: ['NEW', 'CONFIRMED'] },
          returnAt: { gte: now }
        },
        orderBy: [{ pickupAt: 'asc' }, { returnAt: 'asc' }],
        select: vehicleReservationSelect
      }),
      prisma.reservation.findMany({
        where: reservationWhere,
        orderBy: [{ pickupAt: 'desc' }, { createdAt: 'desc' }],
        take: 12,
        select: vehicleReservationSelect
      })
    ]);

    return {
      ...vehicle,
      activeReservation,
      nextReservation,
      recentReservations
    };
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

  async createAvailabilityBlock(vehicleId, payload = {}, scope = {}) {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: vehicleId, ...(byTenantWhere(scope) || {}) },
      select: { id: true, tenantId: true, internalNumber: true }
    });
    if (!vehicle) throw new Error('Vehicle not found');
    const block = normalizeBlockRow(payload);
    if (!block.blockType) throw new Error('blockType is invalid');
    if (!block.availableFrom) throw new Error('availableFrom is required');
    if (block.availableFrom <= block.blockedFrom) throw new Error('availableFrom must be after blockedFrom');
    return prisma.vehicleAvailabilityBlock.create({
      data: {
        tenantId: vehicle.tenantId || scope?.tenantId || null,
        vehicleId: vehicle.id,
        blockType: block.blockType,
        blockedFrom: block.blockedFrom,
        availableFrom: block.availableFrom,
        reason: block.reason,
        notes: block.notes,
        sourceType: payload?.sourceType ? String(payload.sourceType).trim().toUpperCase() : 'MANUAL'
      }
    });
  },

  async releaseAvailabilityBlock(blockId, scope = {}) {
    const block = await prisma.vehicleAvailabilityBlock.findFirst({
      where: {
        id: blockId,
        releasedAt: null,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      select: { id: true }
    });
    if (!block) throw new Error('Availability block not found');
    return prisma.vehicleAvailabilityBlock.update({
      where: { id: block.id },
      data: { releasedAt: new Date() }
    });
  },

  async validateBulkAvailabilityBlocks(rows = [], scope = {}) {
    const vehicles = await prisma.vehicle.findMany({
      where: byTenantWhere(scope),
      select: { id: true, internalNumber: true, plate: true }
    });
    const vehicleByInternal = new Map(vehicles.map((row) => [norm(row.internalNumber).toLowerCase(), row]));
    const vehicleByPlate = new Map(vehicles.map((row) => [norm(row.plate).toLowerCase(), row]).filter(([key]) => key));

    let valid = 0;
    let invalid = 0;
    const reportRows = rows.map((row, idx) => {
      const internalNumber = norm(row.internalNumber);
      const plate = norm(row.plate);
      const vehicle = internalNumber
        ? vehicleByInternal.get(internalNumber.toLowerCase())
        : (plate ? vehicleByPlate.get(plate.toLowerCase()) : null);
      const normalized = normalizeBlockRow(row);
      const errors = [];
      if (!vehicle) errors.push('vehicle not found');
      if (!normalized.blockType) errors.push('blockType invalid');
      if (!normalized.availableFrom) errors.push('availableFrom required');
      if (normalized.availableFrom && normalized.availableFrom <= normalized.blockedFrom) errors.push('availableFrom must be after blockedFrom');
      if (errors.length) invalid += 1;
      else valid += 1;
      return {
        row: idx + 1,
        internalNumber,
        plate,
        vehicleId: vehicle?.id || null,
        blockType: normalized.blockType,
        blockedFrom: normalized.blockedFrom,
        availableFrom: normalized.availableFrom,
        reason: normalized.reason,
        notes: normalized.notes,
        valid: !errors.length,
        errors
      };
    });

    return {
      found: rows.length,
      valid,
      invalid,
      rows: reportRows
    };
  },

  async importBulkAvailabilityBlocks(rows = [], scope = {}) {
    const validation = await this.validateBulkAvailabilityBlocks(rows, scope);
    const validRows = validation.rows.filter((row) => row.valid);
    if (!validRows.length) return { created: 0, skipped: validation.found, validation };

    for (const row of validRows) {
      const vehicle = await prisma.vehicle.findFirst({
        where: { id: row.vehicleId, ...(byTenantWhere(scope) || {}) },
        select: { id: true, tenantId: true }
      });
      if (!vehicle) continue;
      await prisma.vehicleAvailabilityBlock.create({
        data: {
          tenantId: vehicle.tenantId || scope?.tenantId || null,
          vehicleId: vehicle.id,
          blockType: row.blockType,
          blockedFrom: row.blockedFrom,
          availableFrom: row.availableFrom,
          reason: row.reason,
          notes: row.notes,
          sourceType: 'BULK_IMPORT'
        }
      });
    }

    return {
      created: validRows.length,
      skipped: validation.found - validRows.length,
      validation
    };
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
      const yearRaw = norm(r.year);
      const vin = norm(r.vin);
      const plate = norm(r.plate);
      const tollTagNumber = norm(r.tollTagNumber);
      const tollStickerNumber = norm(r.tollStickerNumber);
      const vehicleTypeId = norm(r.vehicleTypeId);
      const vehicleTypeCode = norm(r.vehicleTypeCode);
      const vehicleTypeName = norm(r.vehicleTypeName || r.vehicleType);

      const errors = [];
      if (!internalNumber) errors.push('internalNumber required');

      const year = yearRaw === '' ? null : Number(yearRaw);
      if (yearRaw !== '' && (!Number.isInteger(year) || year < 1900 || year > 2100)) {
        errors.push(`year ${yearRaw} is invalid`);
      }

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
        year,
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
          year: Number.isInteger(r.year) ? r.year : null,
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
