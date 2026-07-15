import {
  isPlannerAssignableReservation,
  isPlannerMovableReservation,
  reservationOverlapsRange
} from './planner-utils.mjs';

// NOTE (2026-07-14 board-first rebuild): drag & drop no longer edits dates via
// PATCH /api/reservations/:id. A drop assigns the reservation to the target
// vehicle through POST /api/planner/assign (dates unchanged), so the old
// buildDropMovePlan/buildVehicleClearUpdates helpers were removed.

export function buildClearAssignmentCandidates(reservations, rangeStart, rangeEnd) {
  // Candidates must mirror the backend's ASSIGNABLE_STATUSES (NEW/CONFIRMED) —
  // isPlannerMovableReservation also lets CHECKED_IN etc through, which the
  // /assign endpoint 409s with LOCKED_STATUS and the bulk clear would abort
  // partway on real data (QA MAJOR 2026-07-14).
  return (reservations || []).filter((reservation) => (
    reservation?.vehicleId
    && reservationOverlapsRange(reservation, rangeStart, rangeEnd)
    && isPlannerAssignableReservation(reservation)
  ));
}

export function buildAutoAssignCandidates(reservations) {
  return (reservations || []).filter((reservation) => !reservation?.vehicleId && isPlannerMovableReservation(reservation));
}

export function buildPlannerRangePayload({ rangeStart, rangeEnd, filterLocationId, filterVehicleTypeId, tenantId = '', extra = {} }) {
  return {
    start: rangeStart.toISOString(),
    end: rangeEnd.toISOString(),
    tenantId: tenantId || null,
    locationId: filterLocationId || null,
    vehicleTypeId: filterVehicleTypeId || null,
    ...extra
  };
}
