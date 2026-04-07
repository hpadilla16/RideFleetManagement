import {
  DAY_WIDTH,
  addDays,
  isPlannerMovableReservation,
  reservationOverlapsRange
} from './planner-utils.mjs';

export function buildDropMovePlan({
  reservation,
  trackVehicleId,
  dayIndexRaw,
  dropMetrics = null,
  dragMeta = null,
  rangeStart,
  vehicleTracks
}) {
  if (!reservation) return null;

  const dayIndex = Number(dayIndexRaw);
  if (!Number.isFinite(dayIndex) || dayIndex < 0) return null;

  const oldPickup = new Date(reservation.pickupAt);
  const oldReturn = new Date(reservation.returnAt);
  const duration = oldReturn.getTime() - oldPickup.getTime();
  if (!Number.isFinite(duration)) return null;

  let startDayIndex = dayIndex;
  if (dropMetrics && Number.isFinite(dropMetrics.pointerOffsetWithinCellPx) && Number.isFinite(dragMeta?.grabOffsetPx)) {
    const rawLeftPx = dayIndex * DAY_WIDTH + dropMetrics.pointerOffsetWithinCellPx - dragMeta.grabOffsetPx;
    const preciseStart = Math.max(0, rawLeftPx) / DAY_WIDTH;
    startDayIndex = Math.max(0, Math.floor(preciseStart));
  }

  const newStartDay = addDays(rangeStart, startDayIndex);
  const newPickup = new Date(newStartDay);
  newPickup.setHours(oldPickup.getHours(), oldPickup.getMinutes(), oldPickup.getSeconds(), oldPickup.getMilliseconds());
  const newReturn = new Date(newPickup.getTime() + duration);

  const targetVehicleLabel = trackVehicleId === '__unassigned__'
    ? 'Unassigned'
    : (vehicleTracks.find((track) => track.id === trackVehicleId)?.internalNumber || 'Selected Vehicle');

  return {
    newPickup,
    newReturn,
    targetVehicleLabel,
    patch: {
      vehicleId: trackVehicleId === '__unassigned__' ? null : trackVehicleId,
      pickupAt: newPickup.toISOString(),
      returnAt: newReturn.toISOString()
    }
  };
}

export function buildClearAssignmentCandidates(reservations, rangeStart, rangeEnd) {
  return (reservations || []).filter((reservation) => (
    reservation?.vehicleId
    && reservationOverlapsRange(reservation, rangeStart, rangeEnd)
    && isPlannerMovableReservation(reservation)
  ));
}

export function buildAutoAssignCandidates(reservations) {
  return (reservations || []).filter((reservation) => !reservation?.vehicleId && isPlannerMovableReservation(reservation));
}

export function buildVehicleClearUpdates(candidates) {
  return (candidates || []).map((reservation) => ({
    id: reservation.id,
    patch: { vehicleId: null }
  }));
}

export function buildPlannerRangePayload({ rangeStart, rangeEnd, filterLocationId, filterVehicleTypeId, extra = {} }) {
  return {
    start: rangeStart.toISOString(),
    end: rangeEnd.toISOString(),
    locationId: filterLocationId || null,
    vehicleTypeId: filterVehicleTypeId || null,
    ...extra
  };
}
