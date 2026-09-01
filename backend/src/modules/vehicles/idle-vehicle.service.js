// Idle-vehicle detection (2026-09-01, backlog #5) — notify when a car has been
// sitting on the lot with no reservation activity for N days, N per tenant.
//
// "Observation, not workflow": this module only OBSERVES the fleet and emits
// NotificationEvent envelopes (sourceType FLEET) into the Notification Center.
// There is no idle table, no new Vehicle column — everything derives from rows
// that already exist.
//
// THE IDLE DEFINITION (settled here, tested in idle-vehicle.test.mjs):
//
//   A vehicle is ELIGIBLE for idle detection when
//     - status === AVAILABLE            (IN_MAINTENANCE / OUT_OF_SERVICE /
//                                        SOLD / ON_RENT etc. are never idle)
//     - fleetMode !== CAR_SHARING_ONLY  (car-sharing utilization runs on Trip,
//                                        its own loop — out of scope here)
//     - programCategory !== SHUTTLE_ONLY (shuttles never take reservations and
//                                        would read as perpetually idle)
//   LOANER_ONLY vehicles stay IN scope: the dealership-loaner intake books
//   through the same Reservation table (workflowMode DEALERSHIP_LOANER), so
//   the same activity signals apply.
//
//   An eligible vehicle is NOT idle when it is spoken for:
//     - any reservation on it with status CHECKED_OUT (open rental — belt and
//       braces on top of the status gate), or
//     - any upcoming/active assignment: NEW or CONFIRMED with returnAt >= now.
//
//   lastActivityAt = the most recent of
//     - vehicle.createdAt                                   (cold start)
//     - reservation.createdAt of any non-cancelled reservation ever assigned
//       to it                                               (assignment)
//     - min(reservation.returnAt, now) of any CHECKED_IN / CHECKED_IN_UNPAID
//       reservation                                         (check-in close;
//       capped at `now` so an early return never claims future activity)
//
//   idle when floor((now - lastActivityAt) / day) >= thresholdDays.
//
// EPISODE DEDUPE: dedupeKey = `idle-vehicle:{vehicleId}:{episodeStart}` where
// episodeStart is lastActivityAt's YYYY-MM-DD. The key is stable for as long
// as the episode lasts, so the daily sweep re-emitting is an upsert no-op —
// a car idle 20 days badges once, not daily. New activity moves
// lastActivityAt, which both ends the episode (not idle at next sweep → the
// sweep resolves the open envelope) and re-arms a fresh key for the next one.
//
// RESOLUTION is sweep-owned (one touchpoint): each run resolves any open
// FLEET envelope whose vehicle is no longer idle — or whose episode key no
// longer matches — before emitting the day's rows. No hooks in checkout /
// check-in / assignment code paths.

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { emitNotificationSafe } from '../notifications/notifications-emit.js';
import { settingsService } from '../settings/settings.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const IDLE_DEFAULT_THRESHOLD_DAYS = 7;
export const IDLE_DEFAULT_SEVERITY = 'NEEDS_ACTION';
const IDLE_SEVERITIES = ['CRITICAL', 'NEEDS_ACTION', 'INFO'];

/**
 * Config normalizer — OFF by default (shuttle-tracker precedent: ship inert,
 * a tenant flips it on). Defaults are echoed in settings.service.js
 * getIdleVehicleConfig, same convention as checkinAuditConfig.
 */
export function normalizeIdleVehicleConfig(cfg = {}) {
  const n = Number(cfg?.thresholdDays);
  const severity = String(cfg?.severity || IDLE_DEFAULT_SEVERITY).toUpperCase();
  return {
    enabled: cfg?.enabled === true,
    thresholdDays: Number.isFinite(n) && n >= 1 ? Math.floor(n) : IDLE_DEFAULT_THRESHOLD_DAYS,
    severity: IDLE_SEVERITIES.includes(severity) ? severity : IDLE_DEFAULT_SEVERITY,
  };
}

const OCCUPYING_UPCOMING = new Set(['NEW', 'CONFIRMED']);
const CLOSED_STATUSES = new Set(['CHECKED_IN', 'CHECKED_IN_UNPAID']);

/**
 * Pure idle computation for one vehicle. `vehicle.reservations` is the
 * NON-CANCELLED set (status not in CANCELLED / NO_SHOW) ever assigned to it.
 * Returns { eligible, idle, lastActivityAt, daysIdle, episodeStart, dedupeKey }.
 */
export function computeIdleState(vehicle, { now = new Date(), thresholdDays = IDLE_DEFAULT_THRESHOLD_DAYS } = {}) {
  const none = { eligible: false, idle: false, lastActivityAt: null, daysIdle: 0, episodeStart: null, dedupeKey: null };
  if (!vehicle) return none;
  if (vehicle.status !== 'AVAILABLE') return none;
  if (vehicle.fleetMode === 'CAR_SHARING_ONLY') return none;
  if (vehicle.programCategory === 'SHUTTLE_ONLY') return none;

  const reservations = vehicle.reservations || [];
  let lastActivity = new Date(vehicle.createdAt || now);
  for (const r of reservations) {
    if (r.status === 'CHECKED_OUT') return { ...none, eligible: true }; // on rent
    if (OCCUPYING_UPCOMING.has(r.status) && r.returnAt && new Date(r.returnAt) >= now) {
      return { ...none, eligible: true }; // booked — spoken for, not idle
    }
    if (r.createdAt && new Date(r.createdAt) > lastActivity) {
      lastActivity = new Date(r.createdAt); // assignment counts as activity
    }
    if (CLOSED_STATUSES.has(r.status) && r.returnAt) {
      const closedAt = new Date(Math.min(new Date(r.returnAt).getTime(), now.getTime()));
      if (closedAt > lastActivity) lastActivity = closedAt; // check-in close
    }
  }

  const daysIdle = Math.floor(Math.max(0, now.getTime() - lastActivity.getTime()) / DAY_MS);
  const episodeStart = lastActivity.toISOString().slice(0, 10);
  return {
    eligible: true,
    idle: daysIdle >= thresholdDays,
    lastActivityAt: lastActivity,
    daysIdle,
    episodeStart,
    dedupeKey: `idle-vehicle:${vehicle.id}:${episodeStart}`,
  };
}

function unitLabel(vehicle) {
  return vehicle?.internalNumber || vehicle?.plate || vehicle?.id || 'vehicle';
}

/**
 * One tenant's idle sweep: resolve stale envelopes, emit current episodes.
 * Config OFF means a full no-op for the tenant (no emits, no resolves) —
 * silence is the contract until a tenant opts in.
 * Exported for tests (DI: db / emit / getConfig / now).
 */
export async function sweepIdleVehiclesForTenant(tenantId, deps = {}) {
  const db = deps.db || prisma;
  const emit = deps.emit || emitNotificationSafe;
  const log = deps.logger || logger;
  const now = deps.now ? new Date(deps.now) : new Date();

  let config = normalizeIdleVehicleConfig(null);
  try {
    config = normalizeIdleVehicleConfig(await (deps.getConfig
      ? deps.getConfig({ tenantId })
      : settingsService.getIdleVehicleConfig({ tenantId })));
  } catch { /* defaults (disabled) */ }
  if (!config.enabled) return { tenantId, skipped: true, emitted: 0, resolved: 0 };

  const vehicles = await db.vehicle.findMany({
    where: {
      tenantId,
      status: 'AVAILABLE',
      fleetMode: { in: ['RENTAL_ONLY', 'BOTH'] },
      programCategory: { not: 'SHUTTLE_ONLY' },
    },
    select: {
      id: true,
      plate: true,
      internalNumber: true,
      createdAt: true,
      status: true,
      fleetMode: true,
      programCategory: true,
      homeLocationId: true,
      homeLocation: { select: { name: true } },
      reservations: {
        where: { status: { notIn: ['CANCELLED', 'NO_SHOW'] } },
        select: { status: true, createdAt: true, returnAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      },
    },
    take: 5000,
  });

  const idleByVehicleId = new Map();
  for (const v of vehicles) {
    const state = computeIdleState(v, { now, thresholdDays: config.thresholdDays });
    if (state.idle) idleByVehicleId.set(v.id, { vehicle: v, state });
  }

  // 1) Resolve BEFORE emitting: any open FLEET envelope whose vehicle is no
  //    longer idle, or whose episode key is not the current one. Emitting
  //    after keeps a same-episode open row untouched (its key matches).
  let resolved = 0;
  const open = await db.notificationEvent.findMany({
    where: { tenantId, sourceType: 'FLEET', resolvedAt: null },
    select: { id: true, sourceRefId: true, dedupeKey: true },
  });
  for (const row of open) {
    const current = row.sourceRefId ? idleByVehicleId.get(row.sourceRefId) : null;
    if (current && current.state.dedupeKey === row.dedupeKey) continue; // still this episode
    try {
      await db.notificationEvent.updateMany({
        where: { id: row.id, resolvedAt: null },
        data: { resolvedAt: now },
      });
      resolved += 1;
    } catch (err) {
      log.warn('[idle-vehicle] resolve failed (non-fatal)', { id: row.id, message: err?.message || String(err) });
    }
  }

  // 2) Emit the day's episodes — the stable dedupeKey makes re-detection an
  //    upsert no-op, so a long episode never re-badges.
  let emitted = 0;
  for (const { vehicle, state } of idleByVehicleId.values()) {
    const unit = unitLabel(vehicle);
    const locationName = vehicle.homeLocation?.name || '';
    await emit({
      tenantId,
      locationId: vehicle.homeLocationId || null,
      severity: config.severity,
      sourceType: 'FLEET',
      sourceRefId: vehicle.id,
      title: `Idle vehicle — ${unit}, ${state.daysIdle} days without a rental`,
      body: locationName ? `${locationName} · no reservation activity since ${state.episodeStart}` : `No reservation activity since ${state.episodeStart}`,
      deepLink: `/vehicles/${vehicle.id}`,
      dedupeKey: state.dedupeKey,
      templateKey: 'idleVehicle',
      paramsJson: { unit, days: state.daysIdle, location: locationName },
    });
    emitted += 1;
  }

  return { tenantId, skipped: false, emitted, resolved, idle: idleByVehicleId.size };
}
