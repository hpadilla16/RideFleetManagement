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

  // beta.116 hardening (KII873 incident, 2026-06-05): when a reservationId is
  // available, the reservation's CURRENT vehicleId is the source of truth —
  // a caller-supplied vehicleId can be stale (e.g. RentalAgreement.vehicleId
  // written before the 2026-05-23 swap fix shipped). RES-961024 checked in
  // and the sync freed the agreement's old vehicle (KST795) while the real
  // car (KII873) stayed ON_RENT for two days. If both ids are present and
  // they disagree, sync the reservation's vehicle as primary AND release the
  // stale one (it is no longer on this rental) unless it's locked or still
  // out on another open rental.
  let vid = vehicleId || null;
  let staleVid = null;
  if (reservationId) {
    const reservation = await client.reservation.findUnique({
      where: { id: reservationId },
      select: { vehicleId: true },
    });
    const resVid = reservation?.vehicleId || null;
    if (resVid) {
      if (vid && vid !== resVid) staleVid = vid;
      vid = resVid;
    }
  }
  if (!vid) return null;

  if (staleVid) {
    try {
      const stale = await client.vehicle.findUnique({
        where: { id: staleVid },
        select: { id: true, status: true },
      });
      if (stale && !LOCKED_VEHICLE_STATUSES.includes(stale.status) && stale.status === 'ON_RENT') {
        const stillOut = await client.reservation.count({
          where: { vehicleId: staleVid, status: 'CHECKED_OUT' },
        });
        if (stillOut === 0) {
          await client.vehicle.update({
            where: { id: staleVid },
            data: { status: 'AVAILABLE', updatedAt: new Date() },
          });
        }
      }
    } catch {
      // Best-effort: never let stale-vehicle cleanup break the main sync.
    }
  }

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

/**
 * Drift sweep (beta.116, KII873 incident) — self-healing safety net.
 *
 * Invariant: a vehicle is ON_RENT iff it has a CHECKED_OUT reservation.
 * Historical bad data (pre-fix swaps), crashed transactions, or future
 * code paths that forget to sync can all break it; this sweep repairs both
 * directions and reports what it fixed. Locked statuses are never touched.
 *
 *   ON_RENT  + no CHECKED_OUT reservation -> AVAILABLE  (car is on the lot)
 *   AVAILABLE + a CHECKED_OUT reservation -> ON_RENT    (car is on the road)
 */
export async function sweepVehicleStatusDrift(client) {
  const freed = [];
  const rented = [];

  const stuckOnRent = await client.vehicle.findMany({
    where: {
      status: 'ON_RENT',
      reservations: { none: { status: 'CHECKED_OUT' } },
    },
    select: { id: true, internalNumber: true, plate: true },
  });
  for (const v of stuckOnRent) {
    await client.vehicle.update({
      where: { id: v.id },
      data: { status: 'AVAILABLE', updatedAt: new Date() },
    });
    freed.push({ vehicleId: v.id, internalNumber: v.internalNumber, plate: v.plate });
  }

  const stuckAvailable = await client.vehicle.findMany({
    where: {
      status: 'AVAILABLE',
      reservations: { some: { status: 'CHECKED_OUT' } },
    },
    select: { id: true, internalNumber: true, plate: true },
  });
  for (const v of stuckAvailable) {
    await client.vehicle.update({
      where: { id: v.id },
      data: { status: 'ON_RENT', updatedAt: new Date() },
    });
    rented.push({ vehicleId: v.id, internalNumber: v.internalNumber, plate: v.plate });
  }

  return { freed, rented };
}
