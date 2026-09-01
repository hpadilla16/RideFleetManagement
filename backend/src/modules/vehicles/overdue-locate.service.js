/**
 * Overdue-vehicle locate sweep (Hector, 2026-08-13).
 *
 * "Overdues trigger an event que ping a Voltswitch para que nos de la
 * localización del carro; si está adentro de los boundaries del location del
 * tenant pues está bien, pero si está afuera pues poner una notificación en
 * el dashboard."
 *
 * Runs from the voltswitch scheduler on the same per-tenant cadence as the
 * device sync. For every overdue rental (the canonical rule: CHECKED_OUT and
 * returnAt already passed) whose vehicle carries a Voltswitch device:
 *
 *   1. read the device's current position (getDeviceLocation — the platform's
 *      latest known fix). If that fix is stale, fire locate_on_demand as a
 *      best-effort nudge so the NEXT sweep sees a fresh one — we never sit
 *      waiting for the device to answer;
 *   2. classify the position against the tenant's geofenced locations
 *      (overdue-geofence.js — pure, tested);
 *   3. OUTSIDE  → upsert ONE OPEN OverdueVehicleAlert per reservation
 *      (position refreshed in place, so the dashboard shows where the car is
 *      NOW, not where it was when first noticed);
 *      INSIDE   → auto-resolve any open alert (car is back on a lot; that is
 *      the backdated-checkin workflow, not an alert);
 *      NO_POSITION / NO_GEOFENCE → do nothing. An unknown answer must never
 *      fabricate an alert — same rule as "permission denied must never render
 *      as absence".
 *
 * Also auto-resolves open alerts whose reservation stopped being overdue
 * (checked in, cancelled, extended) — an alert for a closed rental is noise.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import {
  authenticate as voltswitchAuth,
  getDeviceLocation,
  locateOnDemand,
} from './telematics-voltswitch.js';
import { classifyOverduePosition } from './overdue-geofence.js';
import { emitNotificationSafe, resolveNotificationSafe } from '../notifications/notifications-emit.js';

/** A fix older than this triggers a best-effort locate_on_demand nudge. */
const STALE_FIX_MS = 15 * 60 * 1000;

function overdueWhere(tenantId, now = new Date()) {
  // Canonical overdue rule — mirrored from reports.service.js (KPI) and
  // reservations.service.js (?filter=overdue), asserted by
  // overdue-definition.test.mjs: a rental is overdue the moment its planned
  // return passes while still CHECKED_OUT.
  return { tenantId, status: 'CHECKED_OUT', returnAt: { lt: now } };
}

export async function checkOverdueVehiclesForTenant({ tenantId, config }) {
  const results = { checked: 0, outside: 0, resolved: 0, skipped: 0 };

  const locations = await prisma.location.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, name: true, code: true, latitude: true, longitude: true, geofenceRadiusKm: true },
  });
  const hasGeofence = locations.some((l) => l.latitude != null && l.longitude != null);

  // Close the loop on stale alerts first — even if geofences were removed.
  const openAlerts = await prisma.overdueVehicleAlert.findMany({
    where: { tenantId, status: 'OPEN' },
    select: { id: true, reservationId: true },
  });
  if (openAlerts.length) {
    const stillOverdue = new Set(
      (await prisma.reservation.findMany({
        where: { ...overdueWhere(tenantId), id: { in: openAlerts.map((a) => a.reservationId) } },
        select: { id: true },
      })).map((r) => r.id)
    );
    const staleIds = openAlerts.filter((a) => !stillOverdue.has(a.reservationId)).map((a) => a.id);
    if (staleIds.length) {
      await prisma.overdueVehicleAlert.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
      results.resolved += staleIds.length;
    }
  }

  if (!hasGeofence) return results; // nothing to compare against — by design, silent

  const overdue = await prisma.reservation.findMany({
    where: { ...overdueWhere(tenantId), vehicleId: { not: null } },
    select: { id: true, reservationNumber: true, vehicleId: true },
    take: 100,
  });
  if (!overdue.length) return results;

  const devices = await prisma.vehicleTelematicsDevice.findMany({
    where: {
      provider: 'VOLTSWITCH',
      isActive: true,
      vehicleId: { in: overdue.map((r) => r.vehicleId) },
    },
    select: { id: true, vehicleId: true, externalDeviceId: true },
  });
  const deviceByVehicle = new Map(devices.map((d) => [d.vehicleId, d]));
  if (!devices.length) return results;

  const session = await voltswitchAuth({
    username: config.voltswitchApiEmail,
    password: config.voltswitchApiPassword,
    tenantId,
  });

  for (const reservation of overdue) {
    const device = deviceByVehicle.get(reservation.vehicleId);
    if (!device) { results.skipped++; continue; }
    results.checked++;

    let position = null;
    try {
      position = await getDeviceLocation(session, { imei: device.externalDeviceId });
    } catch (err) {
      logger.warn('[overdue-locate] location read failed', {
        tenantId, reservationId: reservation.id, message: err.message,
      });
      continue;
    }

    // Stale fix → nudge the device for next sweep. Best-effort, never awaited
    // into the verdict: this sweep judges with what the platform knows now.
    const fixAge = Date.now() - new Date(position?.eventAt || 0).getTime();
    if (!Number.isFinite(fixAge) || fixAge > STALE_FIX_MS) {
      locateOnDemand(session, { imei: device.externalDeviceId }).catch(() => {});
    }

    const verdict = classifyOverduePosition(position, locations);
    const existing = await prisma.overdueVehicleAlert.findFirst({
      where: { reservationId: reservation.id, status: 'OPEN' },
      select: { id: true },
    });

    if (verdict.verdict === 'OUTSIDE') {
      results.outside++;
      const data = {
        latitude: position.latitude,
        longitude: position.longitude,
        address: position.address || null,
        distanceKm: verdict.distanceKm,
        nearestLocationId: verdict.nearestLocationId,
        positionAt: position.eventAt ? new Date(position.eventAt) : null,
      };
      if (existing) {
        await prisma.overdueVehicleAlert.update({ where: { id: existing.id }, data });
      } else {
        const createdAlert = await prisma.overdueVehicleAlert.create({
          data: {
            tenantId,
            reservationId: reservation.id,
            vehicleId: reservation.vehicleId,
            status: 'OPEN',
            ...data,
          },
        });
        // Notification Center emitter (2026-09-01) — ONLY on the create
        // branch: the update above is a position refresh on an alert staff
        // already know about, and emitting there would re-notify every tick.
        // dedupeKey rides the alert id, so a later re-open (new alert row) is
        // a new event. locationId stays null on purpose: geofence alerts are
        // tenant-wide by design (nearestLocationId is a geofence, not the
        // renting sede). Safe emit — never breaks the sweep.
        await emitNotificationSafe({
          tenantId,
          severity: 'CRITICAL',
          sourceType: 'GEOFENCE',
          sourceRefId: createdAlert.id,
          title: `Overdue & outside geofence — ${reservation.reservationNumber || reservation.id}`,
          body: [
            reservation.reservationNumber ? `RES ${reservation.reservationNumber}` : null,
            position.address ? `last seen near ${position.address}` : null,
            verdict.distanceKm != null ? `${verdict.distanceKm} km from nearest geofence` : null,
          ].filter(Boolean).join(' · ') || null,
          deepLink: `/reservations/${reservation.id}`,
          dedupeKey: `geofence:${createdAlert.id}`,
          templateKey: 'geofence',
          paramsJson: { unit: reservation.reservationNumber || reservation.id },
        });
      }
    } else if (verdict.verdict === 'INSIDE' && existing) {
      await prisma.overdueVehicleAlert.update({
        where: { id: existing.id },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
      // The condition cleared on its own — mark the envelope "Self-resolved".
      await resolveNotificationSafe({ tenantId, sourceType: 'GEOFENCE', sourceRefId: existing.id });
      results.resolved++;
    }
    // NO_POSITION / NO_GEOFENCE: leave the world exactly as it is.
  }

  return results;
}
