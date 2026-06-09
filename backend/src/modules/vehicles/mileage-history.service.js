/**
 * Vehicle mileage history (2026-06-09).
 *
 * Single entry-point for appending an odometer reading to a vehicle's timeline
 * AND keeping Vehicle.mileage / Vehicle.lastOdometerSource in step ("last entry
 * wins"). Every workflow that learns a fresh odometer — check-out, check-in,
 * a manual correction by an agent, or a telematics ping — should call
 * recordMileageEntry() instead of touching Vehicle.mileage directly. That way
 * the vehicle profile can always answer "what's the current mileage, where did
 * it come from, and what's the full history?".
 *
 * Append-only by design: a correction is a NEW row (source = MANUAL), never an
 * edit of an existing one, so the audit trail is never rewritten.
 *
 * The first arg is the DB client: pass a Prisma `tx` when you're already inside
 * an interactive transaction (e.g. checkout finalize) so the entry + the
 * Vehicle mirror commit atomically with the rest of the writes; pass nothing
 * (or the shared `prisma`) for standalone calls.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

export const MILEAGE_ENTRY_SOURCES = ['CHECKOUT', 'CHECKIN', 'MANUAL', 'TELEMATICS', 'IMPORT'];

export async function recordMileageEntry(client, {
  vehicleId,
  tenantId = undefined,
  mileage,
  source,
  reservationId = null,
  rentalAgreementId = null,
  reservationNumber = null,
  note = null,
  actorUserId = null,
  recordedAt = null,
  // Set false for backfill / historical rows so we don't clobber the current
  // odometer with an old reading; mirror the latest separately at the end.
  updateVehicle = true,
} = {}) {
  const db = client || prisma;

  if (!vehicleId) throw new Error('recordMileageEntry: vehicleId is required');

  const value = Number(mileage);
  if (!Number.isFinite(value)) {
    throw new Error('recordMileageEntry: mileage must be a finite number');
  }
  const miles = Math.round(value);
  if (miles < 0) throw new Error('recordMileageEntry: mileage cannot be negative');

  const src = String(source || '').toUpperCase();
  if (!MILEAGE_ENTRY_SOURCES.includes(src)) {
    throw new Error(`recordMileageEntry: invalid source "${source}"`);
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

  const entry = await db.vehicleMileageEntry.create({
    data: {
      vehicleId,
      tenantId: tid ?? null,
      mileage: miles,
      source: src,
      reservationId,
      rentalAgreementId,
      reservationNumber,
      note,
      actorUserId,
      ...(recordedAt ? { recordedAt } : {}),
    },
  });

  // "Last entry wins": mirror onto the vehicle so the profile + the next
  // check-out auto-populate from the freshest value, and lastOdometerSource
  // says which workflow set it. We mirror unconditionally (no >= guard) so a
  // MANUAL correction of a fat-fingered reading actually takes — the history
  // row above is the audit trail if a number is ever questioned.
  if (updateVehicle) {
    const sourceTag = reservationNumber ? `${src}_${reservationNumber}` : src;
    await db.vehicle.update({
      where: { id: vehicleId },
      data: { mileage: miles, lastOdometerSource: sourceTag },
    });
  }

  return entry;
}

/**
 * Best-effort wrapper: logs and swallows errors so a mileage-logging failure
 * never aborts a check-out/check-in that has otherwise succeeded. Use this from
 * non-transactional callers where the surrounding write has already committed.
 */
export async function recordMileageEntrySafe(client, args) {
  try {
    return await recordMileageEntry(client, args);
  } catch (err) {
    logger.warn('[mileage-history] recordMileageEntry failed', {
      vehicleId: args?.vehicleId,
      source: args?.source,
      err: err?.message,
    });
    return null;
  }
}
