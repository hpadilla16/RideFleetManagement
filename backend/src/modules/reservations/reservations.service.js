import { prisma } from '../../lib/prisma.js';

function parseLocationConfig(raw) {
  try {
    if (!raw) return {};
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object') return raw;
  } catch {}
  return {};
}

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

async function ensureNoVehicleConflict({ vehicleId, pickupAt, returnAt, ignoreReservationId = null }, scope = {}) {
  if (!vehicleId) return;

  const start = new Date(pickupAt);
  const end = new Date(returnAt);

  const conflict = await prisma.reservation.findFirst({
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

  const available = candidates.filter((c) => !blocked.has(c.id));
  if (!available.length) return null;

  return available.find((c) => c.homeLocationId && c.homeLocationId === pickupLocationId)?.id || available[0].id;
}

export const reservationsService = {
  async list(scope = {}) {
    const where = scope?.tenantId ? { tenantId: scope.tenantId } : undefined;
    const rows = await prisma.reservation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: true,
        vehicleType: true,
        vehicle: true,
        pickupLocation: true,
        returnLocation: true,
        additionalDrivers: { orderBy: { createdAt: 'asc' } },
        customerInfoReviewedByUser: { select: { id: true, fullName: true, email: true, role: true } },
        readyForPickupByUser: { select: { id: true, fullName: true, email: true, role: true } }
      }
    });
    return rows.map((r) => ({ ...r, ...deriveUnderageAlertForReservation(r) }));
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

    await ensureNoVehicleConflict({
      vehicleId: assignedVehicleId,
      pickupAt: data.pickupAt,
      returnAt: data.returnAt
    }, scope);

    const underageAlert = await buildUnderageAlertNote({
      customerId: data.customerId,
      pickupLocationId: data.pickupLocationId,
      pickupAt: data.pickupAt
    }, scope);

    return prisma.reservation.create({
      data: {
        tenantId: scope?.tenantId || data.tenantId || null,
        reservationNumber: data.reservationNumber,
        sourceRef: data.sourceRef ?? null,
        status: data.status ?? 'NEW',
        customerId: data.customerId,
        vehicleId: assignedVehicleId,
        vehicleTypeId: data.vehicleTypeId ?? null,
        pickupAt: new Date(data.pickupAt),
        returnAt: new Date(data.returnAt),
        pickupLocationId: data.pickupLocationId,
        returnLocationId: data.returnLocationId,
        dailyRate: data.dailyRate ?? null,
        estimatedTotal: data.estimatedTotal ?? null,
        paymentStatus: data.paymentStatus ?? 'PENDING',
        sendConfirmationEmail: data.sendConfirmationEmail ?? true,
        notes: mergeUnderageAlert(data.notes ?? null, underageAlert)
      }
    });
  },

  async update(id, patch, scope = {}) {
    const current = await prisma.reservation.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
    if (!current) throw new Error('Reservation not found');

    const nextVehicleId = patch.vehicleId !== undefined ? patch.vehicleId : current.vehicleId;
    const nextPickupAt = patch.pickupAt ? new Date(patch.pickupAt) : current.pickupAt;
    const nextReturnAt = patch.returnAt ? new Date(patch.returnAt) : current.returnAt;

    const nextCustomerId = patch.customerId !== undefined ? patch.customerId : current.customerId;
    if (nextCustomerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: nextCustomerId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
        select: { doNotRent: true, doNotRentReason: true }
      });
      if (customer?.doNotRent) {
        throw new Error(`Customer is marked DO NOT RENT${customer.doNotRentReason ? `: ${customer.doNotRentReason}` : ''}`);
      }
    }

    const nextPickupLocationId = patch.pickupLocationId !== undefined ? patch.pickupLocationId : current.pickupLocationId;
    const nextReturnLocationId = patch.returnLocationId !== undefined ? patch.returnLocationId : current.returnLocationId;

    await validateLocationWindow({ locationId: nextPickupLocationId, at: nextPickupAt, label: 'Pickup' }, scope);
    await validateLocationWindow({ locationId: nextReturnLocationId, at: nextReturnAt, label: 'Return' }, scope);

    await ensureNoVehicleConflict({
      vehicleId: nextVehicleId,
      pickupAt: nextPickupAt,
      returnAt: nextReturnAt,
      ignoreReservationId: id
    }, scope);

    const nextNotesInput = patch.notes !== undefined ? patch.notes : current.notes;
    const underageAlert = await buildUnderageAlertNote({
      customerId: nextCustomerId,
      pickupLocationId: nextPickupLocationId,
      pickupAt: nextPickupAt
    }, scope);

    const data = {
      ...patch,
      notes: mergeUnderageAlert(nextNotesInput, underageAlert),
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

    delete data.customerId;
    delete data.pickupLocationId;
    delete data.returnLocationId;
    delete data.vehicleTypeId;
    delete data.vehicleId;

    return prisma.reservation.update({
      where: { id },
      data
    });
  },

  async remove(id, scope = {}) {
    const row = await prisma.reservation.findFirst({ where: { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) } });
    if (!row) throw new Error('Reservation not found');
    return prisma.reservation.delete({ where: { id } });
  }
};
