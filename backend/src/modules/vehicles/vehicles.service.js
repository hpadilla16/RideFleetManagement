import { prisma } from '../../lib/prisma.js';
import { normalizeVehicleBlockType } from './vehicle-blocks.js';
import { assertTenantVehicleCapacity } from '../../lib/tenant-plan-limits.js';
import { buildVehicleOperationalSignalsMap } from './vehicle-intelligence.service.js';
import { settingsService } from '../settings/settings.service.js';
import { normalizeZubieWebhookPayload } from './telematics-zubie.js';

const SUPPORTED_TELEMATICS_PROVIDERS = [
  {
    code: 'ZUBIE',
    label: 'Zubie',
    recommended: true,
    integrationStatus: 'PLANNED',
    notes: 'Preferred rental-fleet telematics placeholder. Native webhook and API sync can plug into this provider next.'
  },
  {
    code: 'GENERIC',
    label: 'Generic',
    recommended: false,
    integrationStatus: 'READY',
    notes: 'Use for manual pings or any provider that is not yet mapped natively.'
  },
  {
    code: 'SAMSARA',
    label: 'Samsara',
    recommended: false,
    integrationStatus: 'PLANNED',
    notes: 'Enterprise telematics placeholder reserved for a future connector.'
  },
  {
    code: 'GEOTAB',
    label: 'Geotab',
    recommended: false,
    integrationStatus: 'PLANNED',
    notes: 'Open-platform telematics placeholder reserved for a future connector.'
  },
  {
    code: 'AZUGA',
    label: 'Azuga',
    recommended: false,
    integrationStatus: 'PLANNED',
    notes: 'Webhook-friendly placeholder reserved for a future connector.'
  }
];

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

function activeAvailabilityBlock(blocks = [], now = new Date()) {
  const nowValue = now.getTime();
  return (Array.isArray(blocks) ? blocks : []).find((block) => {
    const releasedAt = block?.releasedAt ? new Date(block.releasedAt).getTime() : null;
    const blockedFrom = block?.blockedFrom ? new Date(block.blockedFrom).getTime() : nowValue;
    const availableFrom = block?.availableFrom ? new Date(block.availableFrom).getTime() : null;
    return !releasedAt && blockedFrom <= nowValue && availableFrom && availableFrom > nowValue;
  }) || null;
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeTelematicsDeviceRow(row = {}) {
  const provider = normalizeTelematicsProvider(row.provider || '');
  return {
    id: row.id,
    provider,
    providerLabel: telematicsProviderLabel(provider),
    externalDeviceId: row.externalDeviceId || '',
    label: row.label || '',
    serialNumber: row.serialNumber || '',
    isActive: !!row.isActive,
    installedAt: row.installedAt || null,
    lastSeenAt: row.lastSeenAt || null,
    metadata: row.metadataJson ? (() => {
      try { return JSON.parse(row.metadataJson); } catch { return {}; }
    })() : {}
  };
}

function telematicsProviderCodes() {
  return new Set(SUPPORTED_TELEMATICS_PROVIDERS.map((row) => row.code));
}

function normalizeTelematicsProvider(value = '') {
  const normalized = norm(value).toUpperCase();
  if (!normalized) return 'ZUBIE';
  return telematicsProviderCodes().has(normalized) ? normalized : 'GENERIC';
}

function telematicsProviderLabel(code = '') {
  return SUPPORTED_TELEMATICS_PROVIDERS.find((row) => row.code === String(code || '').toUpperCase())?.label || 'Generic';
}

function normalizeTelematicsEventRow(row = {}) {
  const payload = row.payloadJson ? (() => {
    try { return JSON.parse(row.payloadJson); } catch { return {}; }
  })() : {};
  return {
    id: row.id,
    deviceId: row.deviceId || null,
    eventType: row.eventType || 'PING',
    eventAt: row.eventAt || null,
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    speedMph: row.speedMph == null ? null : Number(row.speedMph),
    heading: row.heading ?? null,
    odometer: row.odometer ?? null,
    fuelPct: row.fuelPct == null ? null : Number(row.fuelPct),
    batteryPct: row.batteryPct == null ? null : Number(row.batteryPct),
    engineOn: typeof row.engineOn === 'boolean' ? row.engineOn : null,
    payload,
    rawPayload: payload?.rawPayload || payload?.raw || payload,
    providerMeta: payload?.providerMeta || null,
    mappingSummary: payload?.mappingSummary || null
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
  listTelematicsProviders() {
    return SUPPORTED_TELEMATICS_PROVIDERS.map((row) => ({ ...row }));
  },

  list(scope = {}) {
    return prisma.vehicle.findMany({
      where: byTenantWhere(scope),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        tenantId: true,
        internalNumber: true,
        vin: true,
        plate: true,
        tollTagNumber: true,
        tollStickerNumber: true,
        make: true,
        model: true,
        year: true,
        color: true,
        mileage: true,
        status: true,
        fleetMode: true,
        vehicleTypeId: true,
        homeLocationId: true,
        createdAt: true,
        vehicleType: true,
        homeLocation: true,
        availabilityBlocks: {
          where: { releasedAt: null },
          orderBy: [{ blockedFrom: 'asc' }, { availableFrom: 'asc' }],
          select: {
            id: true,
            blockType: true,
            blockedFrom: true,
            availableFrom: true,
            releasedAt: true,
            reason: true,
            notes: true
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
        telematicsDevices: {
          where: { isActive: true },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
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

    const [recentTelematicsEvent, telematicsConfig] = await Promise.all([
      prisma.vehicleTelematicsEvent.findFirst({
        where: {
          vehicleId: vehicle.id,
          ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
        },
        orderBy: [{ eventAt: 'desc' }, { createdAt: 'desc' }]
      }),
      settingsService.getTelematicsConfig(scope).catch(() => null)
    ]);
    const effectiveSignalsMap = await buildVehicleOperationalSignalsMap([vehicle.id], scope, {
      activeBlocksByVehicleId: new Map([[vehicle.id, activeAvailabilityBlock(vehicle.availabilityBlocks)]].filter(([, block]) => !!block)),
      telematicsFeatureEnabled: telematicsConfig?.ready !== false
    });

    return {
      ...vehicle,
      telematicsDevices: (vehicle.telematicsDevices || []).map(normalizeTelematicsDeviceRow),
      latestTelematicsEvent: recentTelematicsEvent ? normalizeTelematicsEventRow(recentTelematicsEvent) : null,
      operationalSignals: effectiveSignalsMap.get(vehicle.id) || null,
      activeReservation,
      nextReservation,
      recentReservations
    };
  },

  async create(data, scope = {}) {
    const tenantId = scope?.allowCrossTenant ? (data.tenantId || null) : (scope?.tenantId || data.tenantId || null);
    await assertTenantVehicleCapacity(tenantId, { vehicleDelta: 1 });
    return prisma.vehicle.create({
      data: {
        tenantId,
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

  async listTelematics(vehicleId, scope = {}) {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: vehicleId, ...(byTenantWhere(scope) || {}) },
      select: { id: true }
    });
    if (!vehicle) throw new Error('Vehicle not found');

    const [devices, events, telematicsConfig] = await Promise.all([
      prisma.vehicleTelematicsDevice.findMany({
        where: { vehicleId, ...(byTenantWhere(scope) || {}) },
        orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }, { createdAt: 'desc' }]
      }),
      prisma.vehicleTelematicsEvent.findMany({
        where: { vehicleId, ...(byTenantWhere(scope) || {}) },
        orderBy: [{ eventAt: 'desc' }, { createdAt: 'desc' }],
        take: 12
      }),
      settingsService.getTelematicsConfig(scope).catch(() => null)
    ]);
    const effectiveSignalsMap = await buildVehicleOperationalSignalsMap([vehicleId], scope, {
      telematicsFeatureEnabled: telematicsConfig?.ready !== false
    });

    return {
      devices: devices.map(normalizeTelematicsDeviceRow),
      recentEvents: events.map(normalizeTelematicsEventRow),
      operationalSignals: effectiveSignalsMap.get(vehicleId) || null
    };
  },

  async registerTelematicsDevice(vehicleId, payload = {}, scope = {}) {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: vehicleId, ...(byTenantWhere(scope) || {}) },
      select: { id: true, tenantId: true }
    });
    if (!vehicle) throw new Error('Vehicle not found');

    const provider = normalizeTelematicsProvider(payload.provider || 'ZUBIE');
    const externalDeviceId = norm(payload.externalDeviceId || payload.deviceId);
    if (!provider) throw new Error('provider is required');
    if (!externalDeviceId) throw new Error('externalDeviceId is required');

    const row = await prisma.vehicleTelematicsDevice.upsert({
      where: {
        provider_externalDeviceId: {
          provider,
          externalDeviceId
        }
      },
      create: {
        tenantId: vehicle.tenantId || scope?.tenantId || null,
        vehicleId: vehicle.id,
        provider,
        externalDeviceId,
        label: norm(payload.label) || null,
        serialNumber: norm(payload.serialNumber) || null,
        isActive: payload?.isActive !== false,
        installedAt: toDateOrNull(payload.installedAt),
        metadataJson: payload?.metadata ? JSON.stringify(payload.metadata) : null
      },
      update: {
        vehicleId: vehicle.id,
        label: norm(payload.label) || null,
        serialNumber: norm(payload.serialNumber) || null,
        isActive: payload?.isActive !== false,
        installedAt: toDateOrNull(payload.installedAt),
        metadataJson: payload?.metadata ? JSON.stringify(payload.metadata) : null
      }
    });

    return normalizeTelematicsDeviceRow(row);
  },

  async ingestZubieWebhook(payload = {}, scope = {}, options = {}) {
    const mapped = normalizeZubieWebhookPayload(payload, {
      ingestSource: options?.ingestSource,
      requestMetadata: options?.requestMetadata
    });
    const externalDeviceId = norm(mapped.externalDeviceId);
    if (!externalDeviceId) throw new Error('externalDeviceId is required');

    const device = await prisma.vehicleTelematicsDevice.findFirst({
      where: {
        provider: 'ZUBIE',
        externalDeviceId,
        ...(byTenantWhere(scope) || {})
      },
      select: {
        id: true,
        vehicleId: true
      }
    });
    if (!device?.vehicleId) throw new Error('Telematics device not found for this vehicle');

    const eventPayload = {
      deviceId: device.id,
      eventType: mapped.eventType,
      eventAt: mapped.eventAt,
      odometer: mapped.odometer,
      fuelPct: mapped.fuelPct,
      batteryPct: mapped.batteryPct,
      speedMph: mapped.speedMph,
      latitude: mapped.latitude,
      longitude: mapped.longitude,
      engineOn: mapped.engineOn,
      payload: {
        rawPayload: mapped.rawPayload,
        providerMeta: mapped.providerMeta,
        mappingSummary: mapped.mappingSummary
      }
    };

    const event = await this.ingestTelematicsEvent(device.vehicleId, eventPayload, scope);
    return {
      accepted: true,
      provider: 'ZUBIE',
      mode: 'PLACEHOLDER',
      ingestSource: mapped.providerMeta?.ingestSource || 'WEBHOOK',
      deviceId: externalDeviceId,
      vehicleId: device.vehicleId,
      providerMeta: mapped.providerMeta,
      mappingSummary: mapped.mappingSummary,
      event
    };
  },

  async ingestTelematicsEvent(vehicleId, payload = {}, scope = {}) {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: vehicleId, ...(byTenantWhere(scope) || {}) },
      select: { id: true, tenantId: true, mileage: true }
    });
    if (!vehicle) throw new Error('Vehicle not found');

    let device = null;
    if (payload?.deviceId) {
      device = await prisma.vehicleTelematicsDevice.findFirst({
        where: {
          id: String(payload.deviceId),
          vehicleId: vehicle.id,
          ...(byTenantWhere(scope) || {})
        }
      });
      if (!device) throw new Error('Telematics device not found for this vehicle');
    } else {
      device = await prisma.vehicleTelematicsDevice.findFirst({
        where: {
          vehicleId: vehicle.id,
          isActive: true,
          ...(byTenantWhere(scope) || {})
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }]
      });
    }

    const eventAt = toDateOrNull(payload.eventAt) || new Date();
    const odometer = toNumberOrNull(payload.odometer);
    const fuelPct = toNumberOrNull(payload.fuelPct);
    const speedMph = toNumberOrNull(payload.speedMph);
    const batteryPct = toNumberOrNull(payload.batteryPct);
    const latitude = toNumberOrNull(payload.latitude);
    const longitude = toNumberOrNull(payload.longitude);

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.vehicleTelematicsEvent.create({
        data: {
          tenantId: vehicle.tenantId || scope?.tenantId || null,
          vehicleId: vehicle.id,
          deviceId: device?.id || null,
          eventType: norm(payload.eventType || 'PING').toUpperCase() || 'PING',
          eventAt,
          latitude,
          longitude,
          speedMph,
          heading: toNumberOrNull(payload.heading),
          odometer,
          fuelPct,
          batteryPct,
          engineOn: typeof payload?.engineOn === 'boolean' ? payload.engineOn : null,
          payloadJson: payload?.payload ? JSON.stringify(payload.payload) : null
        }
      });

      if (device?.id) {
        await tx.vehicleTelematicsDevice.update({
          where: { id: device.id },
          data: { lastSeenAt: eventAt }
        });
      }

      if (Number.isFinite(odometer) && odometer > Number(vehicle.mileage || 0)) {
        await tx.vehicle.update({
          where: { id: vehicle.id },
          data: { mileage: odometer }
        });
      }

      return created;
    });

    return normalizeTelematicsEventRow(row);
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

    await assertTenantVehicleCapacity(scope?.tenantId || null, { vehicleDelta: validRows.length });

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
