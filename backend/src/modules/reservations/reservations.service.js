import { prisma } from '../../lib/prisma.js';
import { activeVehicleBlockOverlapWhere } from '../vehicles/vehicle-blocks.js';
import { hostReviewsService } from '../host-reviews/host-reviews.service.js';
import { settingsService } from '../settings/settings.service.js';
import { parseLocationConfig } from '../../lib/location-config.js';

function ageOnDate(dob, onDate) {
  if (!dob || !onDate) return null;
  const birth = new Date(dob);
  const ref = new Date(onDate);
  if (Number.isNaN(birth.getTime()) || Number.isNaN(ref.getTime())) return null;
  let age = ref.getFullYear() - birth.getFullYear();
  const m = ref.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < birth.getDate())) age--;
  return age;
}

async function buildUnderageAlertNote({ customerId, pickupLocationId, pickupAt }, scope = {}) {
  if (!customerId || !pickupLocationId || !pickupAt) return null;
  const [customer, location] = await Promise.all([
    prisma.customer.findFirst({ where: { id: customerId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { dateOfBirth: true } }),
    prisma.location.findFirst({ where: { id: pickupLocationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) }, select: { locationConfig: true } })
  ]);
  const cfg = parseLocationConfig(location?.locationConfig);
  const enabled = !!cfg.underageAlertEnabled;
  const threshold = Number(cfg.underageAlertAge ?? cfg.chargeAgeMin ?? 21);
  if (!enabled || !Number.isFinite(threshold) || threshold < 16) return null;

  const age = ageOnDate(customer?.dateOfBirth, pickupAt);
  if (age == null || age >= threshold) return null;
  return `[UNDERAGE ALERT] Customer age ${age} is below alert threshold ${threshold}`;
}

function mergeUnderageAlert(notes, alertLine) {
  const base = String(notes || '').replace(/\n?\[UNDERAGE ALERT\][^\n]*/g, '').trim();
  if (!alertLine) return base;
  return `${base}${base ? '\n' : ''}${alertLine}`;
}

function deriveUnderageAlertForReservation(reservation) {
  try {
    const cfg = parseLocationConfig(reservation?.pickupLocation?.locationConfig);
    const enabled = !!cfg?.underageAlertEnabled;
    const threshold = Number(cfg?.underageAlertAge ?? cfg?.chargeAgeMin ?? 21);
    const age = ageOnDate(reservation?.customer?.dateOfBirth, reservation?.pickupAt);
    const underage = !!enabled && Number.isFinite(threshold) && threshold >= 16 && age != null && age < threshold;
    const note = underage ? `[UNDERAGE ALERT] Customer age ${age} is below alert threshold ${threshold}` : null;
    return { underageAlert: underage, underageAlertAge: age, underageAlertThreshold: threshold, underageAlertText: note };
  } catch {
    return { underageAlert: false, underageAlertAge: null, underageAlertThreshold: null, underageAlertText: null };
  }
}

function isOutsideHours(date, openTime, closeTime) {
  if (!openTime || !closeTime) return false;
  const [oh, om] = String(openTime).split(':').map(Number);
  const [ch, cm] = String(closeTime).split(':').map(Number);
  if ([oh, om, ch, cm].some((x) => Number.isNaN(x))) return false;
  const mins = date.getHours() * 60 + date.getMinutes();
  const openMins = oh * 60 + om;
  const closeMins = ch * 60 + cm;
  return mins < openMins || mins > closeMins;
}

function resolveHoursForDate(cfg, date) {
  const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayKey = dayKeys[date.getDay()];
  const weekly = cfg?.weeklyHours?.[dayKey];

  if (weekly && typeof weekly === 'object') {
    return {
      closed: weekly.enabled === false,
      openTime: weekly.open || cfg.operationsOpenTime,
      closeTime: weekly.close || cfg.operationsCloseTime
    };
  }

  return {
    closed: false,
    openTime: cfg.operationsOpenTime,
    closeTime: cfg.operationsCloseTime
  };
}

function scopedSettingKey(baseKey, scope = {}) {
  return scope?.tenantId ? `tenant:${scope.tenantId}:${baseKey}` : baseKey;
}

function formatReservationWallClock(value) {
  if (!value) return '-';
  const iso = value instanceof Date ? value.toISOString() : String(value);
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return String(value);
  const [, year, month, day, hourRaw, minute] = match;
  const hour24 = Number(hourRaw);
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour24 + 11) % 12) + 1;
  return `${Number(month)}/${Number(day)}/${year}, ${hour12}:${minute} ${suffix}`;
}

const reservationListSelect = {
  id: true,
  tenantId: true,
  reservationNumber: true,
  sourceRef: true,
  status: true,
  paymentStatus: true,
  pickupAt: true,
  returnAt: true,
  pickupLocationId: true,
  returnLocationId: true,
  customerId: true,
  vehicleId: true,
  vehicleTypeId: true,
  dailyRate: true,
  estimatedTotal: true,
  notes: true,
  customer: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true
    }
  },
  vehicleType: {
    select: {
      id: true,
      code: true,
      name: true
    }
  },
  vehicle: {
    select: {
      id: true,
      internalNumber: true,
      plate: true,
      make: true,
      model: true,
      year: true
    }
  },
  pickupLocation: {
    select: {
      id: true,
      name: true,
      code: true
    }
  },
  returnLocation: {
    select: {
      id: true,
      name: true,
      code: true
    }
  },
  franchiseId: true,
  franchise: {
    select: {
      id: true,
      code: true,
      name: true
    }
  },
  rentalAgreement: {
    select: {
      id: true,
      total: true,
      paidAmount: true,
      balance: true
    }
  }
};

// Legacy alias
const reservationListBaseSelect = reservationListSelect;

async function hydrateReservationListRows(rows = [], scope = {}) {
  if (!rows.length) return [];

  const customerIds = [...new Set(rows.map((row) => row.customerId).filter(Boolean))];
  const vehicleTypeIds = [...new Set(rows.map((row) => row.vehicleTypeId).filter(Boolean))];
  const vehicleIds = [...new Set(rows.map((row) => row.vehicleId).filter(Boolean))];
  const locationIds = [...new Set(rows.flatMap((row) => [row.pickupLocationId, row.returnLocationId]).filter(Boolean))];

  const [customers, vehicleTypes, vehicles, locations] = await Promise.all([
    customerIds.length
      ? prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true }
        })
      : [],
    vehicleTypeIds.length
      ? prisma.vehicleType.findMany({
          where: { id: { in: vehicleTypeIds }, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
          select: { id: true, code: true, name: true }
        })
      : [],
    vehicleIds.length
      ? prisma.vehicle.findMany({
          where: { id: { in: vehicleIds }, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
          select: { id: true, internalNumber: true, plate: true, make: true, model: true, year: true }
        })
      : [],
    locationIds.length
      ? prisma.location.findMany({
          where: { id: { in: locationIds }, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
          select: { id: true, name: true, code: true }
        })
      : []
  ]);

  const customerById = new Map(customers.map((row) => [row.id, row]));
  const vehicleTypeById = new Map(vehicleTypes.map((row) => [row.id, row]));
  const vehicleById = new Map(vehicles.map((row) => [row.id, row]));
  const locationById = new Map(locations.map((row) => [row.id, row]));

  return rows.map((row) => {
    const hydrated = {
      ...row,
      customer: row.customerId ? customerById.get(row.customerId) || null : null,
      vehicleType: row.vehicleTypeId ? vehicleTypeById.get(row.vehicleTypeId) || null : null,
      vehicle: row.vehicleId ? vehicleById.get(row.vehicleId) || null : null,
      pickupLocation: row.pickupLocationId ? locationById.get(row.pickupLocationId) || null : null,
      returnLocation: row.returnLocationId ? locationById.get(row.returnLocationId) || null : null
    };
    return { ...hydrated, ...deriveUnderageAlertForReservation(hydrated) };
  });
}

function norm(v) {
  return String(v ?? '').trim();
}

function normLower(v) {
  return norm(v).toLowerCase();
}

function clampPositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function vehicleDisplayLabel(vehicle = {}) {
  return [
    [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(' ').trim(),
    vehicle?.plate || vehicle?.internalNumber || ''
  ].filter(Boolean).join(' • ');
}

function normalizeSwapInspectionPayload(payload = {}) {
  return {
    exterior: String(payload?.exterior || 'GOOD').trim().toUpperCase(),
    interior: String(payload?.interior || 'GOOD').trim().toUpperCase(),
    tires: String(payload?.tires || 'GOOD').trim().toUpperCase(),
    lights: String(payload?.lights || 'GOOD').trim().toUpperCase(),
    windshield: String(payload?.windshield || 'GOOD').trim().toUpperCase(),
    fuelLevel: payload?.fuelLevel === '' || payload?.fuelLevel == null ? null : String(payload.fuelLevel),
    odometer: payload?.odometer === '' || payload?.odometer == null ? null : Number(payload.odometer),
    cleanliness: payload?.cleanliness === '' || payload?.cleanliness == null ? null : Number(payload.cleanliness),
    damages: String(payload?.damages || '').trim() || null,
    notes: String(payload?.notes || '').trim() || null,
    photos: payload?.photos && typeof payload.photos === 'object' ? payload.photos : {}
  };
}

function hasFeeAdvisoryFlag(notes) {
  return /\[FEE_ADVISORY_OPEN\s+/i.test(String(notes || ''));
}

function parseDateInput(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function isLegacyPlaceholderDate(value) {
  const raw = norm(value).toLowerCase();
  if (!raw) return false;
  return (
    raw === '1900-01-00t00:00'
    || raw.startsWith('1900-01-00')
    || raw === '0000-00-00t00:00'
    || raw.startsWith('0000-00-00')
    || raw === '0'
  );
}

function parseNumberInput(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const reservationStatuses = new Set(['NEW', 'CONFIRMED', 'CHECKED_OUT', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW']);
const paymentStatuses = new Set(['PENDING', 'PARTIAL', 'PAID', 'REFUNDED', 'VOID']);
const workflowModes = new Set(['RENTAL', 'CAR_SHARING', 'DEALERSHIP_LOANER']);
const loanerBillingModes = new Set(['COURTESY', 'CUSTOMER_PAY', 'WARRANTY', 'INSURANCE', 'INTERNAL']);

async function resolveImportTenant(row, scope = {}, cache) {
  if (scope?.tenantId) {
    if (!cache.tenantById.has(scope.tenantId)) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: scope.tenantId },
        select: { id: true, slug: true, name: true }
      });
      cache.tenantById.set(scope.tenantId, tenant || null);
    }
    return cache.tenantById.get(scope.tenantId);
  }

  const tenantId = norm(row.tenantId);
  const tenantSlug = norm(row.tenantSlug);
  const tenantName = norm(row.tenantName);

  if (tenantId) {
    if (!cache.tenantById.has(tenantId)) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, slug: true, name: true }
      });
      cache.tenantById.set(tenantId, tenant || null);
    }
    return cache.tenantById.get(tenantId);
  }

  if (tenantSlug) {
    const key = tenantSlug.toLowerCase();
    if (!cache.tenantBySlug.has(key)) {
      const tenant = await prisma.tenant.findUnique({
        where: { slug: tenantSlug },
        select: { id: true, slug: true, name: true }
      });
      cache.tenantBySlug.set(key, tenant || null);
    }
    return cache.tenantBySlug.get(key);
  }

  if (tenantName) {
    const key = tenantName.toLowerCase();
    if (!cache.tenantByName.has(key)) {
      const tenant = await prisma.tenant.findFirst({
        where: { name: tenantName },
        select: { id: true, slug: true, name: true }
      });
      cache.tenantByName.set(key, tenant || null);
    }
    return cache.tenantByName.get(key);
  }

  return null;
}

async function resolveImportLocation(tenantId, rawValue, cache) {
  const value = norm(rawValue);
  if (!value) return null;
  const cacheKey = `${tenantId || 'global'}:${value.toLowerCase()}`;
  if (!cache.location.has(cacheKey)) {
    const location = await prisma.location.findFirst({
      where: {
        ...(tenantId ? { tenantId } : {}),
        OR: [
          { id: value },
          { code: value },
          { name: value }
        ]
      },
      select: { id: true, name: true, code: true, tenantId: true }
    });
    cache.location.set(cacheKey, location || null);
  }
  return cache.location.get(cacheKey);
}

async function resolveImportVehicleType(tenantId, row, cache) {
  const directId = norm(row.vehicleTypeId);
  const code = norm(row.vehicleTypeCode);
  const name = norm(row.vehicleTypeName);
  const value = directId || code || name;
  if (!value) return null;
  const cacheKey = `${tenantId || 'global'}:${value.toLowerCase()}`;
  if (!cache.vehicleType.has(cacheKey)) {
    const vehicleType = await prisma.vehicleType.findFirst({
      where: {
        ...(tenantId ? { tenantId } : {}),
        OR: [
          { id: directId || '__none__' },
          ...(code ? [{ code }] : []),
          ...(name ? [{ name }] : [])
        ]
      },
      select: { id: true, name: true, code: true }
    });
    cache.vehicleType.set(cacheKey, vehicleType || null);
  }
  return cache.vehicleType.get(cacheKey);
}

async function resolveImportVehicle(tenantId, row, cache) {
  const directId = norm(row.vehicleId);
  const internalNumber = norm(row.vehicleInternalNumber);
  const plate = norm(
    row.vehiclePlate
    || row.AssignedVehicleLicensePlate
    || row.assignedVehicleLicensePlate
    || row.licensePlate
    || row.plate,
  );
  const value = directId || internalNumber || plate;
  if (!value) return null;
  const cacheKey = `${tenantId || 'global'}:${value.toLowerCase()}`;
  if (!cache.vehicle.has(cacheKey)) {
    const vehicle = await prisma.vehicle.findFirst({
      where: {
        ...(tenantId ? { tenantId } : {}),
        OR: [
          { id: directId || '__none__' },
          ...(internalNumber ? [{ internalNumber }] : []),
          ...(plate ? [{ plate }] : [])
        ]
      },
      select: { id: true, internalNumber: true, plate: true, vehicleTypeId: true }
    });
    cache.vehicle.set(cacheKey, vehicle || null);
  }
  return cache.vehicle.get(cacheKey);
}

async function resolveImportCustomer(tenantId, row, cache) {
  const directId = norm(row.customerId);
  const email = norm(row.customerEmail);
  const phone = norm(row.customerPhone);
  const firstName = norm(row.customerFirstName);
  const lastName = norm(row.customerLastName);

  if (directId) {
    const key = `id:${directId}`;
    if (!cache.customer.has(key)) {
      const customer = await prisma.customer.findFirst({
        where: { id: directId, ...(tenantId ? { tenantId } : {}) },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true }
      });
      cache.customer.set(key, customer || null);
    }
    return { customer: cache.customer.get(key), action: cache.customer.get(key) ? 'existing' : null };
  }

  if (email) {
    const key = `email:${tenantId || 'global'}:${email.toLowerCase()}`;
    if (!cache.customer.has(key)) {
      const customer = await prisma.customer.findFirst({
        where: { ...(tenantId ? { tenantId } : {}), email },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true }
      });
      cache.customer.set(key, customer || null);
    }
    if (cache.customer.get(key)) return { customer: cache.customer.get(key), action: 'existing' };
  }

  if (phone) {
    const key = `phone:${tenantId || 'global'}:${phone.toLowerCase()}`;
    if (!cache.customer.has(key)) {
      const customer = await prisma.customer.findFirst({
        where: { ...(tenantId ? { tenantId } : {}), phone },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true }
      });
      cache.customer.set(key, customer || null);
    }
    if (cache.customer.get(key)) return { customer: cache.customer.get(key), action: 'existing' };
  }

  if (firstName && lastName) {
    return { customer: null, action: 'create' };
  }

  return { customer: null, action: null };
}

function normalizeImportRow(row) {
  const reservationNumber = norm(row.reservationNumber);
  const sourceRef = norm(row.sourceRef) || null;
  const pickupAt = parseDateInput(row.pickupAt);
  const rawReturnAt = norm(row.returnAt);
  let returnAt = parseDateInput(rawReturnAt);
  let returnAtUsedPlaceholder = false;
  if (!returnAt && pickupAt && isLegacyPlaceholderDate(rawReturnAt)) {
    returnAt = new Date(pickupAt.getTime() + (24 * 60 * 60 * 1000));
    returnAtUsedPlaceholder = true;
  }
  const status = norm(row.status || 'CONFIRMED').toUpperCase();
  const paymentStatus = norm(row.paymentStatus || 'PENDING').toUpperCase();
  const workflowMode = norm(row.workflowMode || 'RENTAL').toUpperCase();
  const loanerBillingMode = norm(row.loanerBillingMode).toUpperCase() || null;
  const dailyRate = parseNumberInput(row.dailyRate);
  const estimatedTotal = parseNumberInput(row.estimatedTotal);

  return {
    reservationNumber,
    sourceRef,
    pickupAt,
    returnAt,
    returnAtUsedPlaceholder,
    status,
    paymentStatus,
    workflowMode,
    loanerBillingMode,
    notes: norm(row.notes) || null,
    dailyRate,
    estimatedTotal,
    repairOrderNumber: norm(row.repairOrderNumber) || null,
    claimNumber: norm(row.claimNumber) || null,
    serviceAdvisorName: norm(row.serviceAdvisorName) || null,
    serviceAdvisorEmail: norm(row.serviceAdvisorEmail) || null,
    serviceAdvisorPhone: norm(row.serviceAdvisorPhone) || null,
    serviceStartAt: parseDateInput(row.serviceStartAt),
    estimatedServiceCompletionAt: parseDateInput(row.estimatedServiceCompletionAt),
    serviceVehicleYear: parseNumberInput(row.serviceVehicleYear),
    serviceVehicleMake: norm(row.serviceVehicleMake) || null,
    serviceVehicleModel: norm(row.serviceVehicleModel) || null,
    serviceVehiclePlate: norm(row.serviceVehiclePlate) || null,
    serviceVehicleVin: norm(row.serviceVehicleVin) || null,
    loanerProgramNotes: norm(row.loanerProgramNotes) || null
  };
}

async function buildReservationImportRow(row, index, scope = {}, cache = {}) {
  const normalized = normalizeImportRow(row || {});
  const tenant = await resolveImportTenant(row || {}, scope, cache);
  const tenantId = tenant?.id || scope?.tenantId || null;
  const pickupLocation = await resolveImportLocation(tenantId, row?.pickupLocationId || row?.pickupLocationCode || row?.pickupLocationName, cache);
  const returnLocation = await resolveImportLocation(tenantId, row?.returnLocationId || row?.returnLocationCode || row?.returnLocationName, cache);
  const vehicleType = await resolveImportVehicleType(tenantId, row || {}, cache);
  const vehicle = await resolveImportVehicle(tenantId, row || {}, cache);
  const customerResolution = await resolveImportCustomer(tenantId, row || {}, cache);

  const errors = [];
  const warnings = [];

  if (!tenantId) errors.push('tenantId/tenantSlug required');
  if (!normalized.reservationNumber) errors.push('reservationNumber required');
  if (!normalized.pickupAt) errors.push('pickupAt invalid');
  if (!normalized.returnAt) errors.push('returnAt invalid');
  if (normalized.pickupAt && normalized.returnAt && normalized.pickupAt >= normalized.returnAt) errors.push('returnAt must be after pickupAt');
  if (normalized.returnAtUsedPlaceholder) warnings.push('returnAt placeholder detected in legacy file; import defaulted it to pickupAt + 1 day');
  if (!pickupLocation) errors.push('pickup location not found');
  if (!returnLocation) errors.push('return location not found');
  if (!vehicleType && !vehicle) errors.push('vehicleType or assigned vehicle is required');
  if (!customerResolution.customer && customerResolution.action !== 'create') {
    errors.push('customer not found; provide customerId/email/phone or customerFirstName/customerLastName');
  }
  if (normalized.status && !reservationStatuses.has(normalized.status)) errors.push(`status invalid (${normalized.status})`);
  if (normalized.paymentStatus && !paymentStatuses.has(normalized.paymentStatus)) errors.push(`paymentStatus invalid (${normalized.paymentStatus})`);
  if (normalized.workflowMode && !workflowModes.has(normalized.workflowMode)) errors.push(`workflowMode invalid (${normalized.workflowMode})`);
  if (normalized.loanerBillingMode && !loanerBillingModes.has(normalized.loanerBillingMode)) errors.push(`loanerBillingMode invalid (${normalized.loanerBillingMode})`);
  if (normalized.workflowMode !== 'DEALERSHIP_LOANER' && normalized.loanerBillingMode) warnings.push('loanerBillingMode provided on non-loaner workflow');

  const duplicate = normalized.reservationNumber
    ? await prisma.reservation.findFirst({
        where: {
          ...(tenantId ? { tenantId } : {}),
          OR: [
            { reservationNumber: normalized.reservationNumber },
            ...(normalized.sourceRef ? [{ sourceRef: normalized.sourceRef }] : [])
          ]
        },
        select: { id: true, reservationNumber: true }
      })
    : null;
  if (duplicate) errors.push(`reservationNumber/sourceRef already exists (${duplicate.reservationNumber})`);

  let vehicleConflict = null;
  if (!errors.length && vehicle?.id && normalized.pickupAt && normalized.returnAt) {
    try {
      await ensureNoVehicleConflict({
        vehicleId: vehicle.id,
        pickupAt: normalized.pickupAt,
        returnAt: normalized.returnAt
      }, { tenantId });
    } catch (error) {
      vehicleConflict = String(error?.message || 'Vehicle conflict');
      errors.push(vehicleConflict);
    }
  }

  return {
    row: index + 1,
    valid: errors.length === 0,
    errors,
    warnings,
    duplicateReasons: [],
    tenantId,
    tenantLabel: tenant?.name || tenant?.slug || tenantId || '',
    reservationNumber: normalized.reservationNumber,
    workflowMode: normalized.workflowMode,
    status: normalized.status,
    paymentStatus: normalized.paymentStatus,
    customerAction: customerResolution.action,
    resolvedCustomerId: customerResolution.customer?.id || null,
    resolvedCustomerLabel: customerResolution.customer ? `${customerResolution.customer.firstName} ${customerResolution.customer.lastName}`.trim() : null,
    resolvedVehicleTypeId: vehicleType?.id || vehicle?.vehicleTypeId || null,
    resolvedVehicleTypeLabel: vehicleType?.name || null,
    resolvedVehicleId: vehicle?.id || null,
    resolvedVehicleLabel: vehicle ? `${vehicle.internalNumber}${vehicle.plate ? ` / ${vehicle.plate}` : ''}` : null,
    resolvedPickupLocationId: pickupLocation?.id || null,
    resolvedReturnLocationId: returnLocation?.id || null,
    normalized: {
      ...normalized,
      tenantId,
      customerId: customerResolution.customer?.id || null,
      vehicleTypeId: vehicleType?.id || vehicle?.vehicleTypeId || null,
      vehicleId: vehicle?.id || null,
      pickupLocationId: pickupLocation?.id || null,
      returnLocationId: returnLocation?.id || null,
      customerFirstName: norm(row?.customerFirstName) || null,
      customerLastName: norm(row?.customerLastName) || null,
      customerEmail: norm(row?.customerEmail) || null,
      customerPhone: norm(row?.customerPhone) || null
    }
  };
}

async function createImportedCustomer(prepared, row) {
  if (prepared.customerId) return prepared.customerId;
  const fallbackPhone = prepared.customerPhone || `MIG-${prepared.reservationNumber || Date.now()}`;
  const customer = await prisma.customer.create({
    data: {
      tenantId: prepared.tenantId,
      firstName: prepared.customerFirstName,
      lastName: prepared.customerLastName,
      email: prepared.customerEmail || null,
      phone: fallbackPhone,
      notes: prepared.customerPhone
        ? null
        : '[IMPORT_MIGRATION] Legacy customer imported without phone. Placeholder value assigned automatically.'
    },
    select: { id: true }
  });
  return customer.id;
}

async function completeLinkedCarSharingTripForReservation(reservationId, actorUserId = null, reason = 'Reservation checked in') {
  if (!reservationId) return null;

  const trip = await prisma.trip.findFirst({
    where: { reservationId },
    select: {
      id: true,
      status: true
    }
  });
  if (!trip) return null;

  const currentStatus = String(trip.status || '').toUpperCase();
  if (currentStatus === 'COMPLETED') {
    try {
      await hostReviewsService.issueGuestReviewRequestForTrip(trip.id);
    } catch (error) {
      console.error('Unable to issue host review after reservation patch check-in', error);
    }
    return trip;
  }

  if (!['IN_PROGRESS', 'DISPUTED', 'READY_FOR_PICKUP', 'CONFIRMED', 'RESERVED'].includes(currentStatus)) {
    return trip;
  }

  await prisma.trip.update({
    where: { id: trip.id },
    data: {
      status: 'COMPLETED',
      actualReturnAt: new Date(),
      timelineEvents: {
        create: [{
          eventType: 'TRIP_COMPLETED',
          actorType: actorUserId ? 'TENANT_USER' : 'SYSTEM',
          actorRefId: actorUserId || null,
          notes: reason,
          metadata: JSON.stringify({
            source: 'reservation-status-patch'
          })
        }]
      }
    }
  });

  try {
    await hostReviewsService.issueGuestReviewRequestForTrip(trip.id);
  } catch (error) {
    console.error('Unable to issue host review after reservation trip sync', error);
  }

  return trip;
}

async function validateLocationWindow({ locationId, at, label }, scope = {}) {
  const location = await prisma.location.findFirst({
    where: { id: locationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
    select: { name: true, locationConfig: true }
  });
  if (!location) return;

  const cfg = parseLocationConfig(location.locationConfig);
  const date = new Date(at);
  const ymd = date.toISOString().slice(0, 10);
  const weekday = date.getDay();

  const dayHours = resolveHoursForDate(cfg, date);

  if ((cfg.closedWeekdays || []).includes(weekday) || (cfg.closedDates || []).includes(ymd) || dayHours.closed) {
    throw new Error(`${label} location is closed for ${ymd}`);
  }

  const allowOutside = !!cfg.allowOutsideHours;
  if (!allowOutside && isOutsideHours(date, dayHours.openTime, dayHours.closeTime)) {
    throw new Error(`${label} time is outside operating hours for ${location.name || 'selected location'}`);
  }
}

async function ensureNoVehicleConflict({ vehicleId, pickupAt, returnAt, ignoreReservationId = null }, scope = {}, db = prisma) {
  if (!vehicleId) return;

  const start = new Date(pickupAt);
  const end = new Date(returnAt);

  const conflict = await db.reservation.findFirst({
    where: {
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
      vehicleId,
      id: ignoreReservationId ? { not: ignoreReservationId } : undefined,
      status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
      pickupAt: { lt: end },
      returnAt: { gt: start }
    },
    select: { id: true, reservationNumber: true, pickupAt: true, returnAt: true }
  });

  if (conflict) {
    throw new Error(`Vehicle conflict with reservation ${conflict.reservationNumber}`);
  }
}

async function isAutoAssignEnabled(scope = {}) {
  const row = await prisma.appSetting.findUnique({ where: { key: scopedSettingKey('reservationOptions', scope) } });
  if (!row?.value) return false;
  try {
    const parsed = JSON.parse(row.value);
    return !!parsed?.autoAssignVehicleFromType;
  } catch {
    return false;
  }
}

async function pickAvailableVehicle({ vehicleTypeId, pickupLocationId, pickupAt, returnAt }, scope = {}) {
  if (!vehicleTypeId) return null;

  const candidates = await prisma.vehicle.findMany({
    where: { ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}), status: 'AVAILABLE', vehicleTypeId },
    select: { id: true, homeLocationId: true }
  });
  if (!candidates.length) return null;

  const start = new Date(pickupAt);
  const end = new Date(returnAt);
  const ids = candidates.map((c) => c.id);

  const conflicts = await prisma.reservation.findMany({
    where: {
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
      vehicleId: { in: ids },
      status: { in: ['NEW', 'CONFIRMED', 'CHECKED_OUT'] },
      pickupAt: { lt: end },
      returnAt: { gt: start }
    },
    select: { vehicleId: true }
  });
  const blocked = new Set(conflicts.map((c) => c.vehicleId));

  const blockedAvailability = await prisma.vehicleAvailabilityBlock.findMany({
    where: {
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
      vehicleId: { in: ids },
      ...activeVehicleBlockOverlapWhere({ start, end })
    },
    select: { vehicleId: true }
  });
  blockedAvailability.forEach((row) => {
    if (row?.vehicleId) blocked.add(row.vehicleId);
  });

  const available = candidates.filter((c) => !blocked.has(c.id));
  if (!available.length) return null;

  return available.find((c) => c.homeLocationId && c.homeLocationId === pickupLocationId)?.id || available[0].id;
}

export const reservationsService = {
  async summary(scope = {}) {
    const reservationOptions = await settingsService.getReservationOptions(scope);
    const tenantTimeZone = String(reservationOptions?.tenantTimeZone || 'America/Puerto_Rico');
    // Use wall clock "today" in tenant timezone so counts match what staff see
    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: tenantTimeZone }));
    const todayStr = `${nowInTz.getFullYear()}-${String(nowInTz.getMonth() + 1).padStart(2, '0')}-${String(nowInTz.getDate()).padStart(2, '0')}`;
    const dayStart = new Date(`${todayStr}T00:00:00`);
    const dayEnd = new Date(`${todayStr}T23:59:59.999`);
    const where = scope?.tenantId ? { tenantId: scope.tenantId } : {};

    const [
      pickupsToday,
      returnsToday,
      checkedOut,
      feeAdvisories,
      noShows,
      nextPickup,
      nextReturn,
      nextFeeAdvisory,
      nextNoShow
    ] = await Promise.all([
      prisma.reservation.count({
        where: {
          ...where,
          pickupAt: { gte: dayStart, lte: dayEnd }
        }
      }),
      prisma.reservation.count({
        where: {
          ...where,
          returnAt: { gte: dayStart, lte: dayEnd }
        }
      }),
      prisma.reservation.count({
        where: {
          ...where,
          status: 'CHECKED_OUT'
        }
      }),
      prisma.reservation.count({
        where: {
          ...where,
          notes: { contains: '[FEE_ADVISORY_OPEN' }
        }
      }),
      prisma.reservation.count({
        where: {
          ...where,
          status: 'NO_SHOW'
        }
      }),
      prisma.reservation.findFirst({
        where: {
          ...where,
          status: { in: ['NEW', 'CONFIRMED'] }
        },
        orderBy: [{ pickupAt: 'asc' }],
        select: {
          id: true,
          reservationNumber: true,
          pickupAt: true,
          customer: { select: { firstName: true, lastName: true } }
        }
      }),
      prisma.reservation.findFirst({
        where: {
          ...where,
          status: 'CHECKED_OUT'
        },
        orderBy: [{ returnAt: 'asc' }],
        select: {
          id: true,
          reservationNumber: true,
          returnAt: true,
          customer: { select: { firstName: true, lastName: true } }
        }
      }),
      prisma.reservation.findFirst({
        where: {
          ...where,
          notes: { contains: '[FEE_ADVISORY_OPEN' }
        },
        orderBy: [{ updatedAt: 'desc' }],
        select: {
          id: true,
          reservationNumber: true,
          notes: true,
          customer: { select: { firstName: true, lastName: true } }
        }
      }),
      prisma.reservation.findFirst({
        where: {
          ...where,
          status: 'NO_SHOW'
        },
        orderBy: [{ updatedAt: 'desc' }],
        select: {
          id: true,
          reservationNumber: true,
          customer: { select: { firstName: true, lastName: true } }
        }
      })
    ]);

    const customerLabel = (row) => `${row?.customer?.firstName || ''} ${row?.customer?.lastName || ''}`.trim();
    const nextItems = [
      nextPickup
        ? {
            id: `pickup-${nextPickup.id}`,
            title: 'Next Pickup',
            detail: `${nextPickup.reservationNumber} - ${customerLabel(nextPickup)}`.trim(),
            note: `Pickup scheduled for ${formatReservationWallClock(nextPickup.pickupAt)}.`,
            href: `/reservations/${nextPickup.id}`,
            actionLabel: 'Open Reservation'
          }
        : null,
      nextReturn
        ? {
            id: `return-${nextReturn.id}`,
            title: 'Next Return',
            detail: `${nextReturn.reservationNumber} - ${customerLabel(nextReturn)}`.trim(),
            note: `Return due at ${formatReservationWallClock(nextReturn.returnAt)}.`,
            href: `/reservations/${nextReturn.id}`,
            actionLabel: 'Review Return'
          }
        : null,
      nextFeeAdvisory
        ? {
            id: `fee-${nextFeeAdvisory.id}`,
            title: 'Fee Advisory',
            detail: `${nextFeeAdvisory.reservationNumber} - ${customerLabel(nextFeeAdvisory)}`.trim(),
            note: hasFeeAdvisoryFlag(nextFeeAdvisory.notes)
              ? 'Additional fee advisory is still open on this booking.'
              : 'Reservation still needs fee follow-up.',
            href: `/reservations/${nextFeeAdvisory.id}`,
            actionLabel: 'Resolve Advisory'
          }
        : null,
      nextNoShow
        ? {
            id: `no-show-${nextNoShow.id}`,
            title: 'No-Show Follow-Up',
            detail: `${nextNoShow.reservationNumber} - ${customerLabel(nextNoShow)}`.trim(),
            note: 'This booking was marked no-show and may need follow-up.',
            href: `/reservations/${nextNoShow.id}`,
            actionLabel: 'Review'
          }
        : null
    ].filter(Boolean);

    return {
      pickupsToday,
      returnsToday,
      checkedOut,
      feeAdvisories,
      noShows,
      nextItems,
      tenantTimeZone
    };
  },

  async listPage(options = {}, scope = {}) {
    const query = norm(options.query);
    const take = clampPositiveInt(options.limit, 100, 1, 250);
    const skip = clampPositiveInt(options.offset, 0, 0, 100000);
    const where = {
      ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
      ...(query
        ? {
            OR: [
              { reservationNumber: { contains: query, mode: 'insensitive' } },
              { sourceRef: { contains: query, mode: 'insensitive' } },
              {
                customer: {
                  OR: [
                    { firstName: { contains: query, mode: 'insensitive' } },
                    { lastName: { contains: query, mode: 'insensitive' } },
                    { email: { contains: query, mode: 'insensitive' } },
                    { phone: { contains: query, mode: 'insensitive' } }
                  ]
                }
              }
            ]
          }
        : {})
    };

    const [total, rows] = await Promise.all([
      prisma.reservation.count({ where }),
      prisma.reservation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: reservationListBaseSelect
      })
    ]);

    const hydrated = await hydrateReservationListRows(rows, scope);
    return {
      rows: hydrated,
      total,
      limit: take,
      offset: skip,
      hasMore: skip + hydrated.length < total
    };
  },

  async list(scope = {}, { page = 1, limit = 100 } = {}) {
    const take = Math.min(Math.max(1, Number(limit) || 100), 500);
    const skip = (Math.max(1, Number(page) || 1) - 1) * take;
    const where = scope?.tenantId ? { tenantId: scope.tenantId } : undefined;
    const [rows, total] = await Promise.all([
      prisma.reservation.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, select: reservationListSelect }),
      prisma.reservation.count({ where })
    ]);
    // Relations already included via select — add underage alert derivation
    const items = rows.map((row) => ({ ...row, ...deriveUnderageAlertForReservation(row) }));
    return { items, total, page: Number(page), limit: take, pages: Math.ceil(total / take) };
  },

  async getById(id, scope = {}) {
    const row = await prisma.reservation.findFirst({
      where: {
        id,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      include: {
        customer: true,
        vehicleType: true,
        vehicle: true,
        pickupLocation: true,
        returnLocation: true,
        franchise: true,
        additionalDrivers: { orderBy: { createdAt: 'asc' } },
        customerInfoReviewedByUser: { select: { id: true, fullName: true, email: true, role: true } },
        readyForPickupByUser: { select: { id: true, fullName: true, email: true, role: true } },
        rentalAgreement: {
          include: {
            charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
            payments: { orderBy: { paidAt: 'desc' } }
          }
        }
      }
    });
    if (!row) return null;
    return { ...row, ...deriveUnderageAlertForReservation(row) };
  },

  async create(data, scope = {}) {
    const customer = await prisma.customer.findFirst({
      where: { id: data.customerId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { doNotRent: true, doNotRentReason: true }
    });
    if (customer?.doNotRent) {
      throw new Error(`Customer is marked DO NOT RENT${customer.doNotRentReason ? `: ${customer.doNotRentReason}` : ''}`);
    }

    const duplicate = await prisma.reservation.findFirst({
      where: {
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}),
        OR: [
          { reservationNumber: data.reservationNumber },
          ...(data.sourceRef ? [{ sourceRef: data.sourceRef }] : [])
        ]
      }
    });
    if (duplicate) {
      throw new Error('reservationNumber/sourceRef already exists');
    }

    await validateLocationWindow({ locationId: data.pickupLocationId, at: data.pickupAt, label: 'Pickup' }, scope);
    await validateLocationWindow({ locationId: data.returnLocationId, at: data.returnAt, label: 'Return' }, scope);

    let assignedVehicleId = data.vehicleId ?? null;
    if (!assignedVehicleId) {
      const autoAssign = await isAutoAssignEnabled(scope);
      if (autoAssign) {
        assignedVehicleId = await pickAvailableVehicle({
          vehicleTypeId: data.vehicleTypeId ?? null,
          pickupLocationId: data.pickupLocationId,
          pickupAt: data.pickupAt,
          returnAt: data.returnAt
        }, scope);
      }
    }

    const underageAlert = await buildUnderageAlertNote({
      customerId: data.customerId,
      pickupLocationId: data.pickupLocationId,
      pickupAt: data.pickupAt
    }, scope);

    return prisma.$transaction(async (tx) => {
      // Re-check conflict inside the transaction to prevent race conditions
      await ensureNoVehicleConflict({
        vehicleId: assignedVehicleId,
        pickupAt: data.pickupAt,
        returnAt: data.returnAt
      }, scope, tx);

      return tx.reservation.create({
      include: { customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        reservationNumber: data.reservationNumber,
        sourceRef: data.sourceRef ?? null,
        status: data.status ?? 'NEW',
        bookingChannel: data.bookingChannel ?? 'STAFF',
        workflowMode: data.workflowMode ?? 'RENTAL',
        loanerBillingMode: data.loanerBillingMode ?? null,
        repairOrderNumber: data.repairOrderNumber ?? null,
        claimNumber: data.claimNumber ?? null,
        serviceAdvisorName: data.serviceAdvisorName ?? null,
        serviceAdvisorEmail: data.serviceAdvisorEmail ?? null,
        serviceAdvisorPhone: data.serviceAdvisorPhone ?? null,
        serviceStartAt: data.serviceStartAt ? new Date(data.serviceStartAt) : null,
        estimatedServiceCompletionAt: data.estimatedServiceCompletionAt ? new Date(data.estimatedServiceCompletionAt) : null,
        serviceVehicleYear: data.serviceVehicleYear ?? null,
        serviceVehicleMake: data.serviceVehicleMake ?? null,
        serviceVehicleModel: data.serviceVehicleModel ?? null,
        serviceVehiclePlate: data.serviceVehiclePlate ?? null,
        serviceVehicleVin: data.serviceVehicleVin ?? null,
        loanerLiabilityAccepted: !!data.loanerLiabilityAccepted,
        loanerLiabilityAcceptedAt: data.loanerLiabilityAcceptedAt
          ? new Date(data.loanerLiabilityAcceptedAt)
          : (data.loanerLiabilityAccepted ? new Date() : null),
        loanerProgramNotes: data.loanerProgramNotes ?? null,
        loanerBorrowerPacketJson: data.loanerBorrowerPacketJson ?? null,
        loanerBorrowerPacketCompletedAt: data.loanerBorrowerPacketCompletedAt ? new Date(data.loanerBorrowerPacketCompletedAt) : null,
        loanerBorrowerPacketCompletedBy: data.loanerBorrowerPacketCompletedBy ?? null,
        loanerBillingContactName: data.loanerBillingContactName ?? null,
        loanerBillingContactEmail: data.loanerBillingContactEmail ?? null,
        loanerBillingContactPhone: data.loanerBillingContactPhone ?? null,
        loanerBillingAuthorizationRef: data.loanerBillingAuthorizationRef ?? null,
        loanerBillingNotes: data.loanerBillingNotes ?? null,
        loanerReturnExceptionFlag: !!data.loanerReturnExceptionFlag,
        loanerReturnExceptionNotes: data.loanerReturnExceptionNotes ?? null,
        loanerBillingStatus: data.loanerBillingStatus ?? 'DRAFT',
        loanerBillingSubmittedAt: data.loanerBillingSubmittedAt ? new Date(data.loanerBillingSubmittedAt) : null,
        loanerBillingSettledAt: data.loanerBillingSettledAt ? new Date(data.loanerBillingSettledAt) : null,
        serviceAdvisorNotes: data.serviceAdvisorNotes ?? null,
        serviceAdvisorUpdatedAt: data.serviceAdvisorUpdatedAt ? new Date(data.serviceAdvisorUpdatedAt) : null,
        loanerServiceCompletedAt: data.loanerServiceCompletedAt ? new Date(data.loanerServiceCompletedAt) : null,
        loanerServiceCompletedBy: data.loanerServiceCompletedBy ?? null,
        loanerCloseoutNotes: data.loanerCloseoutNotes ?? null,
        loanerPurchaseOrderNumber: data.loanerPurchaseOrderNumber ?? null,
        loanerDealerInvoiceNumber: data.loanerDealerInvoiceNumber ?? null,
        loanerAccountingNotes: data.loanerAccountingNotes ?? null,
        loanerAccountingClosedAt: data.loanerAccountingClosedAt ? new Date(data.loanerAccountingClosedAt) : null,
        loanerAccountingClosedBy: data.loanerAccountingClosedBy ?? null,
        loanerLastExtendedAt: data.loanerLastExtendedAt ? new Date(data.loanerLastExtendedAt) : null,
        loanerLastVehicleSwapAt: data.loanerLastVehicleSwapAt ? new Date(data.loanerLastVehicleSwapAt) : null,
        customerId: data.customerId,
        vehicleId: assignedVehicleId,
        vehicleTypeId: data.vehicleTypeId ?? null,
        pickupAt: new Date(data.pickupAt),
        returnAt: new Date(data.returnAt),
        pickupLocationId: data.pickupLocationId,
        returnLocationId: data.returnLocationId,
        franchiseId: data.franchiseId ?? null,
        dailyRate: data.dailyRate ?? null,
        estimatedTotal: data.estimatedTotal ?? null,
        paymentStatus: data.paymentStatus ?? 'PENDING',
        sendConfirmationEmail: data.sendConfirmationEmail ?? true,
        notes: mergeUnderageAlert(data.notes ?? null, underageAlert)
      }
      });
    });
  },

  async update(id, patch, scope = {}, actorUserId = null) {
    const current = await prisma.reservation.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
    if (!current) throw new Error('Reservation not found');

    const nextVehicleId = patch.vehicleId !== undefined ? patch.vehicleId : current.vehicleId;
    const nextPickupAt = patch.pickupAt ? new Date(patch.pickupAt) : current.pickupAt;
    const nextReturnAt = patch.returnAt ? new Date(patch.returnAt) : current.returnAt;

    const nextCustomerId = patch.customerId !== undefined ? patch.customerId : current.customerId;
    const nextPickupLocationId = patch.pickupLocationId !== undefined ? patch.pickupLocationId : current.pickupLocationId;
    const nextReturnLocationId = patch.returnLocationId !== undefined ? patch.returnLocationId : current.returnLocationId;

    // Run all validations in parallel
    const [customerCheck, , , , underageAlert] = await Promise.all([
      nextCustomerId
        ? prisma.customer.findFirst({
            where: { id: nextCustomerId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
            select: { doNotRent: true, doNotRentReason: true }
          })
        : null,
      validateLocationWindow({ locationId: nextPickupLocationId, at: nextPickupAt, label: 'Pickup' }, scope),
      validateLocationWindow({ locationId: nextReturnLocationId, at: nextReturnAt, label: 'Return' }, scope),
      ensureNoVehicleConflict({
        vehicleId: nextVehicleId,
        pickupAt: nextPickupAt,
        returnAt: nextReturnAt,
        ignoreReservationId: id
      }, scope),
      buildUnderageAlertNote({
        customerId: nextCustomerId,
        pickupLocationId: nextPickupLocationId,
        pickupAt: nextPickupAt
      }, scope)
    ]);

    if (customerCheck?.doNotRent) {
      throw new Error(`Customer is marked DO NOT RENT${customerCheck.doNotRentReason ? `: ${customerCheck.doNotRentReason}` : ''}`);
    }

    const nextNotesInput = patch.notes !== undefined ? patch.notes : current.notes;

    const data = {
      ...patch,
      notes: mergeUnderageAlert(nextNotesInput, underageAlert),
      serviceStartAt: patch.serviceStartAt
        ? new Date(patch.serviceStartAt)
        : (patch.serviceStartAt === null ? null : undefined),
      estimatedServiceCompletionAt: patch.estimatedServiceCompletionAt
        ? new Date(patch.estimatedServiceCompletionAt)
        : (patch.estimatedServiceCompletionAt === null ? null : undefined),
      loanerLiabilityAcceptedAt: patch.loanerLiabilityAcceptedAt
        ? new Date(patch.loanerLiabilityAcceptedAt)
        : (patch.loanerLiabilityAccepted === true ? new Date() : undefined),
      loanerBorrowerPacketCompletedAt: patch.loanerBorrowerPacketCompletedAt
        ? new Date(patch.loanerBorrowerPacketCompletedAt)
        : (patch.loanerBorrowerPacketCompletedAt === null ? null : undefined),
      loanerBillingSubmittedAt: patch.loanerBillingSubmittedAt
        ? new Date(patch.loanerBillingSubmittedAt)
        : (patch.loanerBillingSubmittedAt === null ? null : undefined),
      loanerBillingSettledAt: patch.loanerBillingSettledAt
        ? new Date(patch.loanerBillingSettledAt)
        : (patch.loanerBillingSettledAt === null ? null : undefined),
      serviceAdvisorUpdatedAt: patch.serviceAdvisorUpdatedAt
        ? new Date(patch.serviceAdvisorUpdatedAt)
        : (patch.serviceAdvisorUpdatedAt === null ? null : undefined),
      loanerServiceCompletedAt: patch.loanerServiceCompletedAt
        ? new Date(patch.loanerServiceCompletedAt)
        : (patch.loanerServiceCompletedAt === null ? null : undefined),
      loanerAccountingClosedAt: patch.loanerAccountingClosedAt
        ? new Date(patch.loanerAccountingClosedAt)
        : (patch.loanerAccountingClosedAt === null ? null : undefined),
      loanerLastExtendedAt: patch.loanerLastExtendedAt
        ? new Date(patch.loanerLastExtendedAt)
        : (patch.loanerLastExtendedAt === null ? null : undefined),
      loanerLastVehicleSwapAt: patch.loanerLastVehicleSwapAt
        ? new Date(patch.loanerLastVehicleSwapAt)
        : (patch.loanerLastVehicleSwapAt === null ? null : undefined),
      pickupAt: patch.pickupAt ? new Date(patch.pickupAt) : undefined,
      returnAt: patch.returnAt ? new Date(patch.returnAt) : undefined
    };

    // Prisma checked update input expects relation operations, not raw FK scalars.
    if (patch.customerId !== undefined) data.customer = { connect: { id: patch.customerId } };
    if (patch.pickupLocationId !== undefined) data.pickupLocation = { connect: { id: patch.pickupLocationId } };
    if (patch.returnLocationId !== undefined) data.returnLocation = { connect: { id: patch.returnLocationId } };
    if (patch.vehicleTypeId !== undefined) {
      data.vehicleType = patch.vehicleTypeId ? { connect: { id: patch.vehicleTypeId } } : { disconnect: true };
    }
    if (patch.vehicleId !== undefined) {
      data.vehicle = patch.vehicleId ? { connect: { id: patch.vehicleId } } : { disconnect: true };
    }
    if (patch.franchiseId !== undefined) {
      data.franchise = patch.franchiseId ? { connect: { id: patch.franchiseId } } : { disconnect: true };
    }

    delete data.customerId;
    delete data.pickupLocationId;
    delete data.returnLocationId;
    delete data.vehicleTypeId;
    delete data.vehicleId;
    delete data.franchiseId;

    const updated = await prisma.reservation.update({
      where: { id },
      data
    });

    if (String(updated.workflowMode || '').toUpperCase() === 'CAR_SHARING' && String(updated.status || '').toUpperCase() === 'CHECKED_IN') {
      await completeLinkedCarSharingTripForReservation(
        updated.id,
        actorUserId,
        'Trip auto-completed from reservation status patch'
      );
    }

    return updated;
  },

  async swapVehicle(id, payload = {}, scope = {}, actorUserId = null, actorIp = null) {
    const current = await prisma.reservation.findFirst({
      where: {
        id,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      },
      include: {
        vehicle: true,
        rentalAgreement: true
      }
    });
    if (!current) throw new Error('Reservation not found');
    if (!current.vehicleId || !current.vehicle) throw new Error('Assign a vehicle to the reservation before swapping');
    if (String(current.status || '').toUpperCase() !== 'CHECKED_OUT') {
      throw new Error('Vehicle swap is only available after the reservation is checked out');
    }
    if (!current.rentalAgreement?.id) throw new Error('No rental agreement exists for this reservation yet');

    const nextVehicleId = String(payload?.vehicleId || '').trim();
    if (!nextVehicleId) throw new Error('vehicleId is required');
    if (nextVehicleId === String(current.vehicleId || '')) throw new Error('Select a different vehicle to swap');

    const nextVehicle = await prisma.vehicle.findFirst({
      where: {
        id: nextVehicleId,
        ...(scope?.tenantId ? { tenantId: scope.tenantId } : {})
      }
    });
    if (!nextVehicle) throw new Error('Selected replacement vehicle not found');

    await ensureNoVehicleConflict({
      vehicleId: nextVehicleId,
      pickupAt: current.pickupAt,
      returnAt: current.returnAt,
      ignoreReservationId: id
    }, scope);

    const previousInspection = normalizeSwapInspectionPayload(payload?.currentCheckin || {});
    const nextInspection = normalizeSwapInspectionPayload(payload?.nextCheckout || {});
    const swapNote = String(payload?.note || '').trim() || null;
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.reservation.update({
        where: { id },
        data: {
          vehicle: { connect: { id: nextVehicleId } },
          loanerLastVehicleSwapAt: now
        }
      });

      await tx.rentalAgreement.update({
        where: { id: current.rentalAgreement.id },
        data: {
          odometerOut: Number.isFinite(nextInspection.odometer) ? nextInspection.odometer : undefined,
          fuelOut: nextInspection.fuelLevel == null ? undefined : Number(nextInspection.fuelLevel),
          cleanlinessOut: Number.isFinite(nextInspection.cleanliness) ? nextInspection.cleanliness : undefined
        }
      });

      await tx.rentalAgreementVehicleSwap.create({
        data: {
          rentalAgreementId: current.rentalAgreement.id,
          actorUserId: actorUserId || null,
          previousVehicleId: current.vehicleId,
          previousVehicleLabel: vehicleDisplayLabel(current.vehicle),
          nextVehicleId,
          nextVehicleLabel: vehicleDisplayLabel(nextVehicle),
          note: swapNote,
          previousCheckedInAt: now,
          nextCheckedOutAt: now,
          previousInspectionJson: JSON.stringify(previousInspection),
          nextInspectionJson: JSON.stringify(nextInspection)
        }
      });

      await tx.auditLog.create({
        data: {
          tenantId: current.tenantId || null,
          reservationId: id,
          actorUserId: actorUserId || null,
          action: 'UPDATE',
          reason: `Vehicle swapped from ${vehicleDisplayLabel(current.vehicle) || current.vehicleId} to ${vehicleDisplayLabel(nextVehicle) || nextVehicleId}`,
          metadata: JSON.stringify({
            reservationVehicleSwap: true,
            previousVehicleId: current.vehicleId,
            nextVehicleId,
            actorIp: actorIp || null,
            note: swapNote,
            currentCheckin: previousInspection,
            nextCheckout: nextInspection
          })
        }
      });
    });

    return this.getById(id, scope);
  },

  async remove(id, scope = {}) {
    const row = await prisma.reservation.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
    if (!row) throw new Error('Reservation not found');
    return prisma.reservation.delete({ where: { id } });
  },

  async validateBulk(rows = [], scope = {}) {
    const cache = {
      tenantById: new Map(),
      tenantBySlug: new Map(),
      tenantByName: new Map(),
      location: new Map(),
      vehicleType: new Map(),
      vehicle: new Map(),
      customer: new Map()
    };

    let validCount = 0;
    let invalidCount = 0;
    const report = [];

    for (let idx = 0; idx < rows.length; idx += 1) {
      const built = await buildReservationImportRow(rows[idx], idx, scope, cache);
      if (built.valid) validCount += 1;
      else invalidCount += 1;
      report.push(built);
    }

    return {
      found: rows.length,
      valid: validCount,
      duplicates: 0,
      invalid: invalidCount,
      rows: report
    };
  },

  async importBulk(rows = [], scope = {}, actorUserId = null) {
    const validation = await this.validateBulk(rows, scope);
    const validRows = validation.rows.filter((row) => row.valid);

    if (!validRows.length) {
      return { created: 0, skipped: validation.found, validation };
    }

    let created = 0;
    // Pre-resolve all customer IDs in parallel before the transaction
    const customerIds = await Promise.all(
      validRows.map((row) => createImportedCustomer(row.normalized, row))
    );

    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < validRows.length; i++) {
        const prepared = validRows[i].normalized;
        const customerId = customerIds[i];
        const importNotes = [
          prepared.notes || null,
          '[IMPORT_MIGRATION] Uploaded from reservation migration tool',
          prepared.returnAtUsedPlaceholder ? '[IMPORT_MIGRATION] Legacy return date placeholder detected; returnAt defaulted to pickupAt + 1 day.' : null
        ].filter(Boolean).join('\n');
        const reservation = await tx.reservation.create({
          data: {
            tenantId: prepared.tenantId,
            reservationNumber: prepared.reservationNumber,
            sourceRef: prepared.sourceRef || null,
            status: prepared.status || 'CONFIRMED',
            bookingChannel: 'MIGRATION',
            workflowMode: prepared.workflowMode || 'RENTAL',
            loanerBillingMode: prepared.loanerBillingMode || null,
            repairOrderNumber: prepared.repairOrderNumber || null,
            claimNumber: prepared.claimNumber || null,
            serviceAdvisorName: prepared.serviceAdvisorName || null,
            serviceAdvisorEmail: prepared.serviceAdvisorEmail || null,
            serviceAdvisorPhone: prepared.serviceAdvisorPhone || null,
            serviceStartAt: prepared.serviceStartAt || null,
            estimatedServiceCompletionAt: prepared.estimatedServiceCompletionAt || null,
            serviceVehicleYear: prepared.serviceVehicleYear || null,
            serviceVehicleMake: prepared.serviceVehicleMake || null,
            serviceVehicleModel: prepared.serviceVehicleModel || null,
            serviceVehiclePlate: prepared.serviceVehiclePlate || null,
            serviceVehicleVin: prepared.serviceVehicleVin || null,
            loanerProgramNotes: prepared.loanerProgramNotes || null,
            customerId,
            vehicleId: prepared.vehicleId || null,
            vehicleTypeId: prepared.vehicleTypeId || null,
            pickupAt: prepared.pickupAt,
            returnAt: prepared.returnAt,
            pickupLocationId: prepared.pickupLocationId,
            returnLocationId: prepared.returnLocationId,
            dailyRate: prepared.dailyRate,
            estimatedTotal: prepared.estimatedTotal,
            paymentStatus: prepared.paymentStatus || 'PENDING',
            sendConfirmationEmail: false,
            notes: importNotes
          }
        });

        await Promise.all([
          tx.reservationPricingSnapshot.upsert({
            where: { reservationId: reservation.id },
            create: {
              reservationId: reservation.id,
              dailyRate: prepared.dailyRate,
              source: 'RESERVATION_IMPORT'
            },
            update: {
              dailyRate: prepared.dailyRate,
              source: 'RESERVATION_IMPORT'
            }
          }),
          tx.auditLog.create({
            data: {
              tenantId: reservation.tenantId,
              reservationId: reservation.id,
              action: 'CREATE',
              actorUserId,
              toStatus: reservation.status,
              metadata: JSON.stringify({
                reservationNumber: reservation.reservationNumber,
                importMigration: true,
                sourceRef: reservation.sourceRef || null
              })
            }
          })
        ]);

        created += 1;
      }
    });

    return {
      created,
      skipped: validation.found - created,
      validation
    };
  }
};
