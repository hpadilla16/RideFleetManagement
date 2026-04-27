import { prisma } from '../../lib/prisma.js';
import { plannerRulesService } from './planner.rules.service.js';
import { buildVehicleOperationalSignalsMap } from '../vehicles/vehicle-intelligence.service.js';
import { settingsService } from '../settings/settings.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const COMMITTED_STATUSES = new Set(['NEW', 'CONFIRMED', 'CHECKED_OUT']);

function tenantWhere(scope = {}) {
  if (scope?.tenantId) return { tenantId: scope.tenantId };
  return scope?.allowCrossTenant ? undefined : { tenantId: '__never__' };
}

function normalizeDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function reservationVehicleTypeId(reservation = {}) {
  return reservation?.vehicleTypeId || reservation?.vehicle?.vehicleTypeId || reservation?.vehicleType?.id || null;
}

function reservationLocationId(reservation = {}) {
  return reservation?.pickupLocationId || reservation?.returnLocationId || reservation?.vehicle?.homeLocationId || null;
}

function reservationOverlapsRange(reservation, start, end) {
  const pickup = new Date(reservation?.pickupAt);
  const ret = new Date(reservation?.returnAt);
  return pickup < end && ret > start;
}

/**
 * Test whether a reservation occupies day [dayStart, nextDayStart) for SHORTAGE
 * forecasting purposes — distinct from "any overlap".
 *
 * Industry "rental day" model tracks 24-hour cycles forward from pickup time.
 * A rental that picks up 4/6 10:00 and returns 4/8 10:00 is two rental days
 * (4/6 + 4/7); the car is back in inventory by end-of-business on 4/8 so it
 * should NOT register as a shortage on 4/8.
 *
 * Rule: the rental occupies day D iff at the END of D (== start of D+1) the
 * car is still rented (pickup < nextDay && return > nextDay). This excludes
 * mid-day returns from the return day.
 *
 * Known edge case: same-day rentals (pickup and return both on D) currently
 * under-count here. Acceptable trade-off for now; tracked as a follow-up.
 */
function reservationOccupiesDayForShortage(reservation, nextDayStart) {
  const pickup = new Date(reservation?.pickupAt);
  const ret = new Date(reservation?.returnAt);
  return pickup < nextDayStart && ret > nextDayStart;
}

function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function isMovablePlannerStatus(status) {
  return COMMITTED_STATUSES.has(String(status || '').toUpperCase());
}

function blockOverlapsDay(block, dayStart, dayEnd) {
  const blockStart = new Date(block.blockedFrom || block.createdAt || dayStart);
  const blockEnd = new Date(block.availableFrom || dayEnd);
  return blockStart < dayEnd && blockEnd > dayStart;
}

function activeAvailabilityBlock(vehicle = {}, now = new Date()) {
  const nowValue = now.getTime();
  return (Array.isArray(vehicle?.availabilityBlocks) ? vehicle.availabilityBlocks : []).find((block) => {
    const releasedAt = block?.releasedAt ? new Date(block.releasedAt).getTime() : null;
    const blockedFrom = block?.blockedFrom ? new Date(block.blockedFrom).getTime() : nowValue;
    const availableFrom = block?.availableFrom ? new Date(block.availableFrom).getTime() : null;
    return !releasedAt && blockedFrom <= nowValue && availableFrom && availableFrom > nowValue;
  }) || null;
}

function laneLayout(items = []) {
  const laneEnds = [];
  const laid = items.map((item) => {
    let lane = laneEnds.findIndex((value) => value <= item.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    return { ...item, lane };
  });
  return {
    items: laid,
    laneCount: Math.max(1, laneEnds.length)
  };
}

function vehicleTrackLabel(vehicle = {}) {
  return {
    id: vehicle.id,
    internalNumber: vehicle.internalNumber,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    plate: vehicle.plate || '',
    status: vehicle.status,
    homeLocationId: vehicle.homeLocationId || null,
    homeLocation: vehicle.homeLocation ? {
      id: vehicle.homeLocation.id,
      name: vehicle.homeLocation.name,
      code: vehicle.homeLocation.code
    } : null,
    vehicleTypeId: vehicle.vehicleTypeId || null,
    vehicleType: vehicle.vehicleType ? {
      id: vehicle.vehicleType.id,
      name: vehicle.vehicleType.name,
      code: vehicle.vehicleType.code
    } : null,
    operationalSignals: vehicle.operationalSignals || null
  };
}

function blockItem(block) {
  return {
    kind: 'block',
    id: block.id,
    blockType: block.blockType,
    blockedFrom: block.blockedFrom,
    availableFrom: block.availableFrom,
    reason: block.reason || '',
    notes: block.notes || '',
    sourceType: block.sourceType || 'MANUAL'
  };
}

function reservationItem(reservation = {}) {
  return {
    kind: 'reservation',
    id: reservation.id,
    reservationNumber: reservation.reservationNumber,
    status: reservation.status,
    pickupAt: reservation.pickupAt,
    returnAt: reservation.returnAt,
    vehicleId: reservation.vehicleId || null,
    vehicleTypeId: reservationVehicleTypeId(reservation),
    pickupLocationId: reservation.pickupLocationId || null,
    returnLocationId: reservation.returnLocationId || null,
    customer: reservation.customer ? {
      id: reservation.customer.id,
      firstName: reservation.customer.firstName,
      lastName: reservation.customer.lastName,
      email: reservation.customer.email,
      phone: reservation.customer.phone
    } : null,
    vehicle: reservation.vehicle ? {
      id: reservation.vehicle.id,
      internalNumber: reservation.vehicle.internalNumber,
      plate: reservation.vehicle.plate || '',
      vehicleTypeId: reservation.vehicle.vehicleTypeId || null,
      homeLocationId: reservation.vehicle.homeLocationId || null
    } : null,
    vehicleType: reservation.vehicleType ? {
      id: reservation.vehicleType.id,
      name: reservation.vehicleType.name,
      code: reservation.vehicleType.code
    } : null,
    pickupLocation: reservation.pickupLocation ? {
      id: reservation.pickupLocation.id,
      name: reservation.pickupLocation.name,
      code: reservation.pickupLocation.code
    } : null,
    returnLocation: reservation.returnLocation ? {
      id: reservation.returnLocation.id,
      name: reservation.returnLocation.name,
      code: reservation.returnLocation.code
    } : null
  };
}

function buildDailyShortageKeyParts(date, vehicleTypeId, locationId) {
  return {
    date: date.toISOString().slice(0, 10),
    vehicleTypeId: vehicleTypeId || 'UNSPECIFIED',
    locationId: locationId || 'UNSPECIFIED'
  };
}

export function normalizePlannerDateRange(input = {}) {
  const start = normalizeDate(input.start || new Date(), 'start');
  const end = normalizeDate(input.end || addDays(startOfDay(start), 7), 'end');
  if (end <= start) throw new Error('end must be later than start');
  return {
    start,
    end
  };
}

export async function loadPlannerReservations({ start, end, locationId = null, vehicleTypeId = null, scope = {} }) {
  const and = [
    {
      pickupAt: { lt: end },
      returnAt: { gt: start }
    }
  ];
  if (locationId) {
    and.push({
      OR: [
        { pickupLocationId: locationId },
        { returnLocationId: locationId },
        { vehicle: { is: { homeLocationId: locationId } } }
      ]
    });
  }
  if (vehicleTypeId) {
    and.push({
      OR: [
        { vehicleTypeId },
        { vehicle: { is: { vehicleTypeId } } }
      ]
    });
  }
  return prisma.reservation.findMany({
    where: {
      ...(tenantWhere(scope) || {}),
      AND: and
    },
    orderBy: [{ pickupAt: 'asc' }, { returnAt: 'asc' }],
    select: {
      id: true,
      tenantId: true,
      reservationNumber: true,
      status: true,
      pickupAt: true,
      returnAt: true,
      vehicleId: true,
      vehicleTypeId: true,
      pickupLocationId: true,
      returnLocationId: true,
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
          name: true,
          code: true
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
      vehicle: {
        select: {
          id: true,
          internalNumber: true,
          plate: true,
          vehicleTypeId: true,
          homeLocationId: true
        }
      }
    }
  });
}

export async function loadPlannerVehicles({ start, end, locationId = null, vehicleTypeId = null, scope = {} }) {
  const rows = await prisma.vehicle.findMany({
    where: {
      ...(tenantWhere(scope) || {}),
      ...(locationId ? { homeLocationId: locationId } : {}),
      ...(vehicleTypeId ? { vehicleTypeId } : {})
    },
    orderBy: [{ make: 'asc' }, { model: 'asc' }, { internalNumber: 'asc' }],
    select: {
      id: true,
      internalNumber: true,
      make: true,
      model: true,
      year: true,
      plate: true,
      status: true,
      vehicleTypeId: true,
      homeLocationId: true,
      vehicleType: {
        select: {
          id: true,
          name: true,
          code: true
        }
      },
      homeLocation: {
        select: {
          id: true,
          name: true,
          code: true
        }
      },
      availabilityBlocks: {
        where: {
          releasedAt: null,
          blockedFrom: { lt: end },
          availableFrom: { gt: start }
        },
        orderBy: [{ blockedFrom: 'asc' }, { availableFrom: 'asc' }],
        select: {
          id: true,
          blockType: true,
          blockedFrom: true,
          availableFrom: true,
          releasedAt: true,
          reason: true,
          notes: true,
          sourceType: true
        }
      }
    }
  });
  return rows.sort((left, right) => {
    const leftType = `${left?.vehicleType?.name || ''}${left?.vehicleType?.code || ''}`.toLowerCase();
    const rightType = `${right?.vehicleType?.name || ''}${right?.vehicleType?.code || ''}`.toLowerCase();
    if (leftType !== rightType) return leftType.localeCompare(rightType);
    const leftLabel = `${left?.make || ''} ${left?.model || ''} ${left?.internalNumber || ''}`.toLowerCase();
    const rightLabel = `${right?.make || ''} ${right?.model || ''} ${right?.internalNumber || ''}`.toLowerCase();
    return leftLabel.localeCompare(rightLabel);
  });
}

export function buildOccupancyMap({ vehicles = [], reservations = [], ignoredReservationIds = new Set() }) {
  const occupancy = new Map();
  (vehicles || []).forEach((vehicle) => occupancy.set(vehicle.id, []));

  (reservations || []).forEach((reservation) => {
    if (!reservation?.vehicleId || ignoredReservationIds.has(reservation.id)) return;
    if (!isMovablePlannerStatus(reservation.status)) return;
    if (!occupancy.has(reservation.vehicleId)) return;
    const start = new Date(reservation.pickupAt).getTime();
    const end = new Date(reservation.returnAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    occupancy.get(reservation.vehicleId).push({
      type: 'reservation',
      reservationId: reservation.id,
      start,
      end
    });
  });

  (vehicles || []).forEach((vehicle) => {
    const list = occupancy.get(vehicle.id) || [];
    (Array.isArray(vehicle.availabilityBlocks) ? vehicle.availabilityBlocks : []).forEach((block) => {
      if (block?.releasedAt) return;
      const start = new Date(block.blockedFrom || new Date()).getTime();
      const end = new Date(block.availableFrom).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      list.push({
        type: 'block',
        blockId: block.id,
        start,
        end
      });
    });
    list.sort((a, b) => a.start - b.start);
    occupancy.set(vehicle.id, list);
  });

  return occupancy;
}

function findOverbookedReservations({ reservations = [], vehicles = [], occupancy = new Map(), rules = {} }) {
  const committedVehicles = vehicles.filter((vehicle) => !['OUT_OF_SERVICE', 'IN_MAINTENANCE'].includes(String(vehicle.status || '').toUpperCase()));
  return reservations
    .filter((reservation) => !reservation.vehicleId && isMovablePlannerStatus(reservation.status))
    .filter((reservation) => {
      const requiredVehicleTypeId = reservationVehicleTypeId(reservation);
      const pickupLocationId = reservation.pickupLocationId || null;
      const start = new Date(reservation.pickupAt).getTime();
      const end = new Date(reservation.returnAt).getTime();
      const compatible = committedVehicles.some((vehicle) => {
        if (rules.strictVehicleTypeMatch && requiredVehicleTypeId && vehicle.vehicleTypeId !== requiredVehicleTypeId) return false;
        if (!rules.allowCrossLocationReassignment && pickupLocationId && vehicle.homeLocationId && vehicle.homeLocationId !== pickupLocationId) return false;
        const intervals = occupancy.get(vehicle.id) || [];
        return !intervals.some((interval) => intervalsOverlap(interval.start, interval.end, start, end));
      });
      return !compatible;
    })
    .map((reservation) => reservation.id);
}

function calculateShortage({ start, end, reservations = [], vehicles = [] }) {
  const days = [];
  const byTypeMax = new Map();
  const byLocationMax = new Map();
  let totalCarsNeeded = 0;

  const startCursor = startOfDay(start);
  const endCursor = startOfDay(end);
  for (let day = new Date(startCursor); day < endCursor; day = addDays(day, 1)) {
    const nextDay = addDays(day, 1);
    const activeReservations = reservations.filter((reservation) => (
      isMovablePlannerStatus(reservation.status) && reservationOccupiesDayForShortage(reservation, nextDay)
    ));
    const activeVehicles = vehicles.filter((vehicle) => {
      if (['IN_MAINTENANCE', 'OUT_OF_SERVICE'].includes(String(vehicle.status || '').toUpperCase())) return false;
      const blocks = Array.isArray(vehicle.availabilityBlocks) ? vehicle.availabilityBlocks : [];
      return !blocks.some((block) => blockOverlapsDay(block, day, nextDay));
    });

    const demandByType = new Map();
    const supplyByType = new Map();
    const demandByLocation = new Map();
    const supplyByLocation = new Map();

    activeReservations.forEach((reservation) => {
      const typeId = reservationVehicleTypeId(reservation) || 'UNSPECIFIED';
      const locationId = reservationLocationId(reservation) || 'UNSPECIFIED';
      demandByType.set(typeId, (demandByType.get(typeId) || 0) + 1);
      demandByLocation.set(locationId, (demandByLocation.get(locationId) || 0) + 1);
    });

    activeVehicles.forEach((vehicle) => {
      const typeId = vehicle.vehicleTypeId || 'UNSPECIFIED';
      const locationId = vehicle.homeLocationId || 'UNSPECIFIED';
      supplyByType.set(typeId, (supplyByType.get(typeId) || 0) + 1);
      supplyByLocation.set(locationId, (supplyByLocation.get(locationId) || 0) + 1);
    });

    let dayCarsNeeded = 0;
    for (const [typeId, demand] of demandByType.entries()) {
      const shortage = Math.max(0, demand - (supplyByType.get(typeId) || 0));
      if (shortage > 0) {
        byTypeMax.set(typeId, Math.max(shortage, byTypeMax.get(typeId) || 0));
      }
      dayCarsNeeded += shortage;
    }
    for (const [locationId, demand] of demandByLocation.entries()) {
      const shortage = Math.max(0, demand - (supplyByLocation.get(locationId) || 0));
      if (shortage > 0) {
        byLocationMax.set(locationId, Math.max(shortage, byLocationMax.get(locationId) || 0));
      }
    }
    totalCarsNeeded = Math.max(totalCarsNeeded, dayCarsNeeded);
    const dateKey = buildDailyShortageKeyParts(day).date;
    if (dayCarsNeeded > 0) days.push({ date: dateKey, carsNeeded: dayCarsNeeded });
  }

  return {
    totalCarsNeeded,
    byDate: days,
    byVehicleType: [...byTypeMax.entries()].map(([vehicleTypeId, carsNeeded]) => ({ vehicleTypeId, carsNeeded })),
    byLocation: [...byLocationMax.entries()].map(([locationId, carsNeeded]) => ({ locationId, carsNeeded }))
  };
}

export const plannerService = {
  async getSnapshot(input = {}, scope = {}) {
    const { start, end } = normalizePlannerDateRange(input);
    const locationId = input.locationId ? String(input.locationId) : null;
    const vehicleTypeId = input.vehicleTypeId ? String(input.vehicleTypeId) : null;
    const rules = await plannerRulesService.resolveEffectiveRules({ scope, locationId, vehicleTypeId });
    const [reservations, vehicles, telematicsConfig] = await Promise.all([
      loadPlannerReservations({ start, end, locationId, vehicleTypeId, scope }),
      loadPlannerVehicles({ start, end, locationId, vehicleTypeId, scope }),
      settingsService.getTelematicsConfig(scope).catch(() => null)
    ]);
    const activeBlocksByVehicleId = new Map(vehicles.map((vehicle) => [vehicle.id, activeAvailabilityBlock(vehicle)]).filter(([, block]) => !!block));
    const signalsMap = await buildVehicleOperationalSignalsMap(vehicles.map((vehicle) => vehicle.id), scope, {
      activeBlocksByVehicleId,
      telematicsFeatureEnabled: telematicsConfig?.ready !== false
    });
    const vehiclesWithSignals = vehicles.map((vehicle) => ({
      ...vehicle,
      operationalSignals: signalsMap.get(vehicle.id) || null
    }));

    const occupancy = buildOccupancyMap({ vehicles: vehiclesWithSignals, reservations });
    const overbookedReservationIds = findOverbookedReservations({ reservations, vehicles: vehiclesWithSignals, occupancy, rules });
    const shortage = calculateShortage({ start, end, reservations, vehicles: vehiclesWithSignals });

    const tracks = vehiclesWithSignals.map((vehicle) => {
      const items = [];
      reservations
        .filter((reservation) => reservation.vehicleId === vehicle.id && reservationOverlapsRange(reservation, start, end))
        .forEach((reservation) => {
          const startOffset = (new Date(reservation.pickupAt).getTime() - start.getTime()) / DAY_MS;
          const endOffset = (new Date(reservation.returnAt).getTime() - start.getTime()) / DAY_MS;
          items.push({
            ...reservationItem(reservation),
            start: Math.max(0, startOffset),
            end: Math.max(0.1, endOffset),
            span: Math.max(0.15, endOffset - startOffset)
          });
        });
      (Array.isArray(vehicle.availabilityBlocks) ? vehicle.availabilityBlocks : []).forEach((block) => {
        const startOffset = (new Date(block.blockedFrom).getTime() - start.getTime()) / DAY_MS;
        const endOffset = (new Date(block.availableFrom).getTime() - start.getTime()) / DAY_MS;
        items.push({
          ...blockItem(block),
          start: Math.max(0, startOffset),
          end: Math.max(0.1, endOffset),
          span: Math.max(0.15, endOffset - startOffset)
        });
      });
      items.sort((left, right) => left.start - right.start);
      return {
        vehicle: vehicleTrackLabel(vehicle),
        ...laneLayout(items)
      };
    });

    const unassignedReservations = reservations
      .filter((reservation) => !reservation.vehicleId && isMovablePlannerStatus(reservation.status))
      .map((reservation) => ({
        ...reservationItem(reservation),
        overbooked: overbookedReservationIds.includes(reservation.id)
      }));

    return {
      range: {
        start: start.toISOString(),
        end: end.toISOString()
      },
      filters: {
        locationId,
        vehicleTypeId
      },
      rules,
      counters: {
        pickups: reservations.filter((reservation) => startOfDay(reservation.pickupAt).getTime() === startOfDay(start).getTime()).length,
        returns: reservations.filter((reservation) => startOfDay(reservation.returnAt).getTime() === startOfDay(start).getTime()).length,
        checkedOut: reservations.filter((reservation) => String(reservation.status || '').toUpperCase() === 'CHECKED_OUT').length,
        serviceHolds: vehiclesWithSignals.filter((vehicle) => (vehicle.availabilityBlocks || []).some((block) => ['MAINTENANCE_HOLD', 'OUT_OF_SERVICE_HOLD'].includes(String(block.blockType || '').toUpperCase()))).length,
        turnReadyAttention: vehiclesWithSignals.filter((vehicle) => ['WATCH', 'ATTENTION', 'BLOCKED'].includes(String(vehicle.operationalSignals?.turnReady?.status || '').toUpperCase())).length,
        turnReadyBlocked: vehiclesWithSignals.filter((vehicle) => String(vehicle.operationalSignals?.turnReady?.status || '').toUpperCase() === 'BLOCKED').length,
        inspectionAttention: vehiclesWithSignals.filter((vehicle) => vehicle.operationalSignals?.inspection?.status === 'ATTENTION').length,
        damageReviewAttention: vehiclesWithSignals.filter((vehicle) => ['MEDIUM', 'HIGH'].includes(String(vehicle.operationalSignals?.inspection?.damageTriage?.severity || '').toUpperCase())).length,
        telematicsAttention: vehiclesWithSignals.filter((vehicle) => ['STALE', 'OFFLINE', 'NO_SIGNAL'].includes(String(vehicle.operationalSignals?.telematics?.status || '').toUpperCase())).length,
        lowFuelAttention: vehiclesWithSignals.filter((vehicle) => ['LOW', 'CRITICAL'].includes(String(vehicle.operationalSignals?.telematics?.fuelStatus || '').toUpperCase())).length,
        gpsAttention: vehiclesWithSignals.filter((vehicle) => String(vehicle.operationalSignals?.telematics?.gpsStatus || '').toUpperCase() === 'MISSING').length,
        unassigned: unassignedReservations.length,
        overbooked: overbookedReservationIds.length
      },
      reservations: reservations.map((reservation) => reservationItem(reservation)),
      vehicles: vehiclesWithSignals.map((vehicle) => ({
        ...vehicleTrackLabel(vehicle),
        availabilityBlocks: (vehicle.availabilityBlocks || []).map((block) => blockItem(block))
      })),
      tracks,
      unassignedReservations,
      overbookedReservations: unassignedReservations.filter((reservation) => reservation.overbooked),
      shortage,
      recommendationSummary: {
        assignmentRecommendations: unassignedReservations.length,
        fleetShortageAlerts: shortage.totalCarsNeeded > 0 ? 1 : 0
      }
    };
  }
};

export {
  DAY_MS,
  COMMITTED_STATUSES,
  tenantWhere,
  reservationVehicleTypeId,
  reservationLocationId,
  reservationOverlapsRange,
  intervalsOverlap,
  isMovablePlannerStatus,
  calculateShortage
};
