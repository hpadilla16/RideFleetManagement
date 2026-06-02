/**
 * vehicle-status-sync — single source of truth for keeping Vehicle.status in
 * step with Reservation.status (fix for bug #44).
 *
 * Historically the checkout flow set Reservation.status = CHECKED_OUT but never
 * flipped Vehicle.status to ON_RENT, and the check-in flow never flipped it back
 * to AVAILABLE. Vehicle.status then drifted from reality, which the dashboard /
 * availability search read literally — so returned cars looked rented (and were
 * un-bookable) while rented cars looked free. This module centralizes the map so
 * every Reservation.status writer can sync the vehicle the same way.
 *
 * Mapping (decided 2026-06-02): a vehicle is ON_RENT *only* while the rental is
 * CHECKED_OUT. In every other reservation state the car is physically on the lot
 * — including CHECKED_IN_UNPAID (checked in, balance pending, autocharge queued)
 * — so it reads AVAILABLE and can be re-rented.
 *
 *   CHECKED_OUT                      -> ON_RENT
 *   NEW / CONFIRMED / PENDING_*      -> AVAILABLE
 *   CHECKED_IN / CHECKED_IN_UNPAID   -> AVAILABLE
 *   CANCELLED / NO_SHOW              -> AVAILABLE
 *
 * Locked vehicle states are NEVER overwritten — a car in maintenance, out of
 * service, or sold keeps that status regardless of the reservation.
 */

// Vehicle states we must never clobber by a reservation transition.
export const LOCKED_VEHICLE_STATUSES = ['IN_MAINTENANCE', 'OUT_OF_SERVICE', 'SOLD'];

/**
 * Map a ReservationStatus to the Vehicle.status it implies, or null if the
 * status carries no opinion about the vehicle.
 */
export function inferVehicleStatusForReservationStatus(resStatus) {
  switch (resStatus) {
    case 'CHECKED_OUT':
      return 'ON_RENT';
    case 'NEW':
    case 'CONFIRMED':
    case 'PENDING_FRANCHISE_IMPORT':
    case 'CHECKED_IN':
    case 'CHECKED_IN_UNPAID':
    case 'CANCELLED':
    case 'NO_SHOW':
      return 'AVAILABLE';
    default:
      return null;
  }
}

/**
 * Sync the vehicle tied to a reservation to the status implied by `toStatus`.
 *
 * Safe to call inside or outside a transaction — pass the same client/tx you're
 * already using so the vehicle write joins that transaction's atomicity.
 *
 * @param {object} client  Prisma client or interactive-transaction client.
 * @param {object} args
 * @param {string} [args.reservationId]  Reservation whose vehicle to sync.
 * @param {string} [args.vehicleId]      Vehicle to sync (skips reservation lookup).
 * @param {string} args.toStatus         The new ReservationStatus.
 * @returns {Promise<object|null>} Sync result:
 *   - { from, to, vehicleId, internalNumber, plate }  applied a change
 *   - { noop: true, status }                          already correct
 *   - { skipped: true, reason }                        vehicle is locked
 *   - null                                             no vehicle / no opinion
 */
export async function syncVehicleStatusForReservation(client, { reservationId, vehicleId, toStatus } = {}) {
  const target = inferVehicleStatusForReservationStatus(toStatus);
  if (!target) return null;

  let vid = vehicleId || null;
  if (!vid && reservationId) {
    const reservation = await client.reservation.findUnique({
      where: { id: reservationId },
      select: { vehicleId: true },
    });
    vid = reservation?.vehicleId || null;
  }
  if (!vid) return null;

  const vehicle = await client.vehicle.findUnique({
    where: { id: vid },
    select: { id: true, status: true, internalNumber: true, plate: true },
  });
  if (!vehicle) return null;

  if (LOCKED_VEHICLE_STATUSES.includes(vehicle.status)) {
    return { skipped: true, reason: `vehicle is ${vehicle.status}`, vehicleId: vehicle.id };
  }
  if (vehicle.status === target) {
    return { noop: true, status: vehicle.status, vehicleId: vehicle.id };
  }

  await client.vehicle.update({
    where: { id: vehicle.id },
    data: { status: target, updatedAt: new Date() },
  });

  return {
    from: vehicle.status,
    to: target,
    vehicleId: vehicle.id,
    internalNumber: vehicle.internalNumber,
    plate: vehicle.plate,
  };
}
