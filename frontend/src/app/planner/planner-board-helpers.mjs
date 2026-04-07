import {
  activeAvailabilityBlock,
  DAY_MS,
  hasInspectionAttention,
  hasTelematicsAttention,
  hasTurnReadyAttention,
  isMigrationHold,
  isServiceHold,
  isWashHold,
  startOfDay,
  turnReadyStatus
} from './planner-utils.mjs';

export function buildLockedReservationIds(reservations) {
  return new Set((reservations || [])
    .filter((reservation) => String(reservation.status || '').toUpperCase() === 'CHECKED_OUT')
    .map((reservation) => reservation.id));
}

export function filterPlannerVehicles(vehicles, filterVehicleTypeId, filterLocationId) {
  return (vehicles || []).filter((vehicle) => {
    if (filterVehicleTypeId && vehicle.vehicleTypeId !== filterVehicleTypeId) return false;
    if (filterLocationId && vehicle.homeLocationId !== filterLocationId) return false;
    return true;
  });
}

export function buildVehicleTracks(filteredVehicles) {
  return [
    {
      id: '__unassigned__',
      make: 'Unassigned',
      model: 'Reservations',
      year: '',
      internalNumber: '-',
      vehicleTypeId: '__unassigned__',
      vehicleType: { code: 'N/A', name: 'Unassigned Reservations' }
    },
    ...(filteredVehicles || []).slice().sort((left, right) => {
      const leftType = `${left?.vehicleType?.name || ''}${left?.vehicleType?.code || ''}`.toLowerCase();
      const rightType = `${right?.vehicleType?.name || ''}${right?.vehicleType?.code || ''}`.toLowerCase();
      if (leftType !== rightType) return leftType.localeCompare(rightType);
      const leftLabel = `${left?.make || ''} ${left?.model || ''} ${left?.internalNumber || ''}`.toLowerCase();
      const rightLabel = `${right?.make || ''} ${right?.model || ''} ${right?.internalNumber || ''}`.toLowerCase();
      return leftLabel.localeCompare(rightLabel);
    })
  ];
}

export function buildTrackRows(vehicleTracks) {
  const rows = [{
    kind: 'track',
    id: '__track__unassigned__',
    vehicle: vehicleTracks[0]
  }];
  const grouped = new Map();
  vehicleTracks.slice(1).forEach((vehicle) => {
    const typeId = String(vehicle?.vehicleTypeId || vehicle?.vehicleType?.id || 'unknown');
    const current = grouped.get(typeId) || {
      id: typeId,
      label: vehicle?.vehicleType?.name || vehicle?.vehicleType?.code || 'Other Vehicles',
      code: vehicle?.vehicleType?.code || '',
      vehicles: []
    };
    current.vehicles.push(vehicle);
    grouped.set(typeId, current);
  });

  [...grouped.values()]
    .sort((left, right) => `${left.label} ${left.code}`.localeCompare(`${right.label} ${right.code}`))
    .forEach((group) => {
      rows.push({
        kind: 'group',
        id: `group-${group.id}`,
        label: group.label,
        code: group.code,
        count: group.vehicles.length
      });
      group.vehicles.forEach((vehicle) => {
        rows.push({
          kind: 'track',
          id: `track-${vehicle.id}`,
          vehicle
        });
      });
    });

  return rows;
}

export function buildItemsByTrack({ vehicleTracks, reservations, vehicles, rangeStart, rangeEnd, dayCount }) {
  const map = new Map();
  for (const track of vehicleTracks) map.set(track.id, []);

  for (const reservation of reservations || []) {
    const pickup = new Date(reservation.pickupAt);
    const returnAt = new Date(reservation.returnAt);
    if (!(pickup < rangeEnd && returnAt > rangeStart)) continue;
    const vehicleId = reservation.vehicleId || '__unassigned__';
    if (!map.has(vehicleId)) continue;

    const start = Math.max(0, (pickup.getTime() - rangeStart.getTime()) / DAY_MS);
    const end = Math.min(dayCount, (returnAt.getTime() - rangeStart.getTime()) / DAY_MS);
    const span = Math.max(0.15, end - start);
    map.get(vehicleId).push({ kind: 'reservation', reservation, start, span, end });
  }

  for (const vehicle of vehicles || []) {
    if (!map.has(vehicle.id)) continue;
    for (const block of Array.isArray(vehicle.availabilityBlocks) ? vehicle.availabilityBlocks : []) {
      const blockedFrom = new Date(block.blockedFrom || block.createdAt || new Date());
      const availableFrom = new Date(block.availableFrom);
      const releasedAt = block?.releasedAt ? new Date(block.releasedAt) : null;
      if (releasedAt || Number.isNaN(blockedFrom.getTime()) || Number.isNaN(availableFrom.getTime())) continue;
      if (!(blockedFrom < rangeEnd && availableFrom > rangeStart)) continue;

      const start = Math.max(0, (blockedFrom.getTime() - rangeStart.getTime()) / DAY_MS);
      const end = Math.min(dayCount, (availableFrom.getTime() - rangeStart.getTime()) / DAY_MS);
      const span = Math.max(0.15, end - start);
      map.get(vehicle.id).push({ kind: 'block', block, vehicle, start, span, end });
    }
  }

  for (const [key, items] of map) {
    items.sort((left, right) => left.start - right.start);
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
    map.set(key, { items: laid, lanes: Math.max(1, laneEnds.length) });
  }

  return map;
}

export function buildPlannerOpsBoard({
  reservations,
  vehicles,
  lockedReservationIds,
  overbookedReservationIds,
  plannerMaintenancePlan,
  plannerWashPlan
}) {
  const sameDay = (value) => {
    const date = new Date(value);
    const today = startOfDay(new Date());
    const check = startOfDay(date);
    return check.getTime() === today.getTime();
  };

  const upcoming = (reservations || [])
    .filter((reservation) => ['CONFIRMED', 'NEW'].includes(String(reservation?.status || '').toUpperCase()))
    .sort((left, right) => new Date(left.pickupAt) - new Date(right.pickupAt));
  const returns = (reservations || [])
    .filter((reservation) => String(reservation?.status || '').toUpperCase() === 'CHECKED_OUT')
    .sort((left, right) => new Date(left.returnAt) - new Date(right.returnAt));
  const unassigned = (reservations || []).filter((reservation) => !reservation?.vehicleId);
  const movable = upcoming.find((reservation) => !lockedReservationIds.has(reservation.id)) || unassigned[0] || returns[0] || null;

  const nextItems = [
    upcoming[0]
      ? {
          id: `pickup-${upcoming[0].id}`,
          focus: 'PICKUPS',
          title: 'Next Pickup',
          detail: `${upcoming[0].reservationNumber} - ${upcoming[0].customer?.firstName || ''} ${upcoming[0].customer?.lastName || ''}`.trim(),
          note: `Pickup ${new Date(upcoming[0].pickupAt).toLocaleString()}`,
          href: `/reservations/${upcoming[0].id}/checkout`,
          actionLabel: 'Open Check-out'
        }
      : null,
    returns[0]
      ? {
          id: `return-${returns[0].id}`,
          focus: 'RETURNS',
          title: 'Next Return',
          detail: `${returns[0].reservationNumber} - ${returns[0].customer?.firstName || ''} ${returns[0].customer?.lastName || ''}`.trim(),
          note: `Return ${new Date(returns[0].returnAt).toLocaleString()}`,
          href: `/reservations/${returns[0].id}/checkin`,
          actionLabel: 'Open Check-in'
        }
      : null,
    unassigned[0]
      ? {
          id: `unassigned-${unassigned[0].id}`,
          focus: 'UNASSIGNED',
          title: 'Unassigned Unit',
          detail: `${unassigned[0].reservationNumber} - ${unassigned[0].customer?.firstName || ''} ${unassigned[0].customer?.lastName || ''}`.trim(),
          note: 'This booking still needs a vehicle assignment in the planner.',
          href: `/reservations/${unassigned[0].id}`,
          actionLabel: 'Open Workflow'
        }
      : null,
    movable
      ? {
          id: `move-${movable.id}`,
          focus: 'MOVABLE',
          title: 'Next Movable Booking',
          detail: `${movable.reservationNumber} - ${movable.customer?.firstName || ''} ${movable.customer?.lastName || ''}`.trim(),
          note: movable.vehicleId ? 'Booking can be dragged on the planner if the lane needs to rebalance inventory.' : 'Best candidate to place onto a vehicle track.',
          href: `/reservations/${movable.id}`,
          actionLabel: 'Review Booking'
        }
      : null
  ].filter(Boolean);

  return {
    pickupsToday: (reservations || []).filter((reservation) => sameDay(reservation.pickupAt)).length,
    returnsToday: (reservations || []).filter((reservation) => sameDay(reservation.returnAt)).length,
    checkedOut: (reservations || []).filter((reservation) => String(reservation?.status || '').toUpperCase() === 'CHECKED_OUT').length,
    migrationHolds: (vehicles || []).filter((vehicle) => isMigrationHold(activeAvailabilityBlock(vehicle))).length,
    serviceHolds: (vehicles || []).filter((vehicle) => isServiceHold(activeAvailabilityBlock(vehicle))).length,
    washHolds: (vehicles || []).filter((vehicle) => isWashHold(activeAvailabilityBlock(vehicle))).length,
    turnReadyAttention: (vehicles || []).filter((vehicle) => hasTurnReadyAttention(vehicle)).length,
    turnReadyBlocked: (vehicles || []).filter((vehicle) => turnReadyStatus(vehicle) === 'BLOCKED').length,
    inspectionAttention: (vehicles || []).filter((vehicle) => hasInspectionAttention(vehicle)).length,
    telematicsAttention: (vehicles || []).filter((vehicle) => hasTelematicsAttention(vehicle)).length,
    unassigned: unassigned.length,
    overbooked: overbookedReservationIds.length,
    maintenanceRecommendations: plannerMaintenancePlan?.recommendations?.length || 0,
    washViolations: plannerWashPlan?.violations?.length || 0,
    nextItems
  };
}

export function buildPlannerFocusOptions(plannerOpsBoard) {
  return [
    { id: 'ALL', label: 'All Queues', count: plannerOpsBoard.nextItems.length },
    { id: 'PICKUPS', label: 'Pickups', count: plannerOpsBoard.nextItems.filter((item) => item.focus === 'PICKUPS').length },
    { id: 'RETURNS', label: 'Returns', count: plannerOpsBoard.nextItems.filter((item) => item.focus === 'RETURNS').length },
    { id: 'UNASSIGNED', label: 'Unassigned', count: plannerOpsBoard.nextItems.filter((item) => item.focus === 'UNASSIGNED').length },
    { id: 'MOVABLE', label: 'Movable', count: plannerOpsBoard.nextItems.filter((item) => item.focus === 'MOVABLE').length }
  ];
}

export function buildPlannerFocusSummary(plannerFocus) {
  switch (plannerFocus) {
    case 'PICKUPS':
      return 'Focus the lane on departures that still need keys, documents, or unit readiness before release.';
    case 'RETURNS':
      return 'Keep only return work visible so the shift can receive vehicles faster from phone or tablet.';
    case 'UNASSIGNED':
      return 'Show only bookings still waiting on a vehicle assignment before they hit the counter.';
    case 'MOVABLE':
      return 'Highlight the best booking to drag next when rebalancing inventory across the timeline.';
    default:
      return 'Quick counters and next bookings to touch before dragging units around the planner grid.';
  }
}

export function buildPlannerFocusItems(plannerFocus, plannerOpsBoard) {
  if (plannerFocus === 'ALL') return plannerOpsBoard.nextItems;
  return plannerOpsBoard.nextItems.filter((item) => item.focus === plannerFocus);
}
