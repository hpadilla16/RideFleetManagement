/**
 * Vehicle fuel reading history (2026-06-29).
 *
 * Sibling to mileage-history.service.js. Single entry-point for appending a
 * fuel-level reading to a vehicle's timeline. Every workflow that learns a
 * fresh fuel level — check-out (fuelOut), check-in (fuelIn), an admin
 * correction, a manual refuel log, or an import — should call
 * recordFuelReading()/recordFuelReadingSafe() so the vehicle profile can show
 * the full fuel + odometer history (paired with VehicleMileageEntry by
 * reservationId).
 *
 * Append-only by design: a correction is a NEW row (source = CORRECTION),
 * never an edit of an existing one, so the audit trail is never rewritten.
 *
 * Unlike mileage, there is no "current fuel" column on Vehicle to mirror onto —
 * the live fuel level lives on the RentalAgreement (fuelOut/fuelIn). This
 * service only appends the timeline row.
 *
 * The first arg is the DB client: pass a Prisma `tx` when you're already inside
 * an interactive transaction so the entry commits atomically with the rest of
 * the writes; pass nothing (or the shared `prisma`) for standalone calls.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

export const FUEL_READING_SOURCES = ['CHECKOUT', 'CHECKIN', 'MANUAL', 'CORRECTION', 'REFUEL', 'IMPORT'];

export async function recordFuelReading(client, {
  vehicleId,
  tenantId = undefined,
  fuelFraction,
  source,
  reservationId = null,
  rentalAgreementId = null,
  reservationNumber = null,
  note = null,
  actorUserId = null,
  recordedAt = null,
} = {}) {
  const db = client || prisma;

  if (!vehicleId) throw new Error('recordFuelReading: vehicleId is required');

  const value = Number(fuelFraction);
  if (!Number.isFinite(value)) {
    throw new Error('recordFuelReading: fuelFraction must be a finite number');
  }
  // Fuel is a 0..1 fraction of tank. Clamp to that range and round to 2dp to
  // match the Decimal(4,2) column (also the 1/8-tank granularity used at the UI).
  const fraction = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;

  const src = String(source || '').toUpperCase();
  if (!FUEL_READING_SOURCES.includes(src)) {
    throw new Error(`recordFuelReading: invalid source "${source}"`);
  }

  // Keep the row tenant-scoped even if the caller didn't pass tenantId.
  let tid = tenantId;
  if (tid === undefined) {
    try {
      const v = await db.vehicle.findUnique({ where: { id: vehicleId }, select: { tenantId: true } });
      tid = v?.tenantId ?? null;
    } catch {
      tid = null;
    }
  }

  return db.vehicleFuelReading.create({
    data: {
      vehicleId,
      tenantId: tid ?? null,
      fuelFraction: fraction,
      source: src,
      reservationId,
      rentalAgreementId,
      reservationNumber,
      note,
      actorUserId,
      ...(recordedAt ? { recordedAt } : {}),
    },
  });
}

/**
 * Best-effort wrapper: logs and swallows errors so a fuel-logging failure
 * never aborts a check-out/check-in/correction that has otherwise succeeded.
 */
export async function recordFuelReadingSafe(client, args) {
  try {
    return await recordFuelReading(client, args);
  } catch (err) {
    logger.warn('[fuel-history] recordFuelReading failed', {
      vehicleId: args?.vehicleId,
      source: args?.source,
      err: err?.message,
    });
    return null;
  }
}
