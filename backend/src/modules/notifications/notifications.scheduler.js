// Notification Center daily sweep (2026-09-01) — NOTES gap B3 + the 30-day
// auto-archive. Same scheduler family as every other *.scheduler.js in the
// repo (fixed daily UTC time like retention.scheduler.js, default-ON opt-out
// flag like checkout-session.scheduler.js), registered in worker.js with the
// dynamic-import try/catch idiom. NOT a new cron mechanism.
//
// Three jobs, all edge-event emitters or bounded cleanups:
//   1. Maintenance OVERDUE — no cron watches maintenanceService.due() today;
//      this emits one NEEDS_ACTION envelope per (schedule, service baseline)
//      the day it is seen overdue. The dedupeKey embeds the lastService
//      baseline, so logging the service re-arms the emitter for the NEXT
//      overdue episode without re-firing the old one.
//   2. Registration / marbete expiry — Vehicle.registrationExpiresAt entering
//      the 30-day window (INFO) and crossing into expired (NEEDS_ACTION).
//      One event per vehicle per expiry date; renewing moves the date and
//      re-arms the window.
//   3. 30-day auto-archive of the feed (the honest footer line).
//
// Cross-tenant discipline: maintenanceService.due() reads EVERY tenant when
// scope is empty (tenantWhere({}) === {}), so the sweep iterates tenants
// explicitly and passes { tenantId } for both query and scope. Location scope
// does not apply — a sweep has no caller; each envelope carries the vehicle's
// own homeLocationId and the feed scopes at read time.
//
// Daily at 09:10 UTC — staggered off 07:00 (checkout cleanup) and 08:30
// (retention), per the retention header's staggering rule.

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { emitNotificationSafe } from './notifications-emit.js';
import { notificationsService } from './notifications.service.js';

const SWEEP_HOUR_UTC = 9;
const SWEEP_MINUTE_UTC = 10;
const REG_WINDOW_DAYS = 30; // mirrors reports.service.js registrationsExpiring30d
const DAY_MS = 24 * 60 * 60 * 1000;

let sweepTimer = null;
let sweepInProgress = false;

export function enabled() {
  // Default ON (opt-out) — the sweep only writes envelope rows and archives
  // old ones; there is nothing destructive to gate behind an opt-in.
  return String(process.env.NOTIFICATIONS_SWEEP_ENABLED || 'true').toLowerCase() !== 'false';
}

export function msUntilNextRun(now = new Date()) {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    SWEEP_HOUR_UTC, SWEEP_MINUTE_UTC, 0, 0,
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function unitLabel(vehicle) {
  return vehicle?.internalNumber || vehicle?.plate || vehicle?.id || 'vehicle';
}

const SERVICE_LABELS = {
  LOF: 'Oil change',
  TIRE_ROTATION: 'Tire rotation',
  BRAKES: 'Brakes',
  INSPECTION: 'Inspection',
  OTHER: 'Service',
};

/** One tenant's maintenance-overdue edge events. Exported for tests. */
export async function emitMaintenanceOverdueForTenant(tenantId, deps = {}) {
  const emit = deps.emit || emitNotificationSafe;
  const { maintenanceService } = deps.maintenanceService
    ? { maintenanceService: deps.maintenanceService }
    : await import('../maintenance/maintenance.service.js');
  const due = await maintenanceService.due({}, { tenantId });
  let emitted = 0;
  for (const item of due.items || []) {
    if (item.state !== 'OVERDUE') continue; // due-soon stays on the dashboards
    const baseline = item.lastServiceMiles ?? (item.lastServiceAt ? new Date(item.lastServiceAt).toISOString().slice(0, 10) : 'init');
    const unit = unitLabel(item.vehicle);
    const service = SERVICE_LABELS[item.serviceType] || item.serviceType;
    const overdueBy = item.dueByMiles != null
      ? `${Math.abs(Math.round(item.dueByMiles)).toLocaleString('en-US')} mi`
      : (item.dueByDays != null ? `${Math.abs(Math.round(item.dueByDays))} days` : '');
    await emit({
      tenantId,
      locationId: item.vehicle?.homeLocationId || null,
      severity: 'NEEDS_ACTION',
      sourceType: 'MAINTENANCE',
      sourceRefId: item.id,
      title: `Maintenance overdue — ${service}, ${unit}`,
      body: overdueBy ? `${overdueBy} overdue` : 'Overdue',
      deepLink: '/maintenance',
      dedupeKey: `maint-overdue:${item.id}:${baseline}`,
      templateKey: 'maintOverdue',
      paramsJson: { unit, service, overdueBy },
    });
    emitted += 1;
  }
  return emitted;
}

/** One tenant's registration/marbete expiry edge events. Exported for tests. */
export async function emitRegistrationExpiryForTenant(tenantId, deps = {}) {
  const emit = deps.emit || emitNotificationSafe;
  const db = deps.prisma || prisma;
  const now = deps.now ? new Date(deps.now) : new Date();
  const cutoff = new Date(now.getTime() + REG_WINDOW_DAYS * DAY_MS);
  const vehicles = await db.vehicle.findMany({
    where: {
      tenantId,
      registrationExpiresAt: { not: null, lte: cutoff },
    },
    select: {
      id: true, plate: true, internalNumber: true,
      registrationExpiresAt: true, homeLocationId: true,
    },
    take: 500,
  });
  let emitted = 0;
  for (const v of vehicles) {
    const expiresAt = new Date(v.registrationExpiresAt);
    const dateKey = expiresAt.toISOString().slice(0, 10);
    const unit = unitLabel(v);
    const days = Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS);
    if (days > 0) {
      await emit({
        tenantId,
        locationId: v.homeLocationId || null,
        severity: 'INFO', // due-soon is awareness; never badges
        sourceType: 'DOCUMENTS',
        sourceRefId: v.id,
        title: `Registration expires in ${days} days — ${unit}`,
        body: `Marbete due ${dateKey}`,
        deepLink: `/vehicles/${v.id}`,
        dedupeKey: `reg-expiry:${v.id}:${dateKey}`,
        templateKey: 'regExpiring',
        paramsJson: { unit, days, date: dateKey },
      });
    } else {
      // Crossing into expired is its own edge — a NEEDS_ACTION event even if
      // the INFO window event already fired (separate dedupeKey).
      await emit({
        tenantId,
        locationId: v.homeLocationId || null,
        severity: 'NEEDS_ACTION',
        sourceType: 'DOCUMENTS',
        sourceRefId: v.id,
        title: `Registration expired — ${unit}`,
        body: `Marbete expired ${dateKey}`,
        deepLink: `/vehicles/${v.id}`,
        dedupeKey: `reg-expired:${v.id}:${dateKey}`,
        templateKey: 'regExpired',
        paramsJson: { unit, date: dateKey },
      });
    }
    emitted += 1;
  }
  return emitted;
}

/** The whole sweep. Exported for tests / manual triggering. */
export async function sweepOnce(deps = {}) {
  const db = deps.prisma || prisma;
  const log = deps.logger || logger;
  const tenants = await db.tenant.findMany({ select: { id: true } });
  const out = { tenants: tenants.length, maintenance: 0, registrations: 0, archived: 0 };
  for (const t of tenants) {
    // Per-tenant try/catch: one bad tenant never aborts the sweep.
    try {
      out.maintenance += await emitMaintenanceOverdueForTenant(t.id, deps);
      out.registrations += await emitRegistrationExpiryForTenant(t.id, deps);
    } catch (err) {
      log.warn('[notifications] sweep failed for tenant (continuing)', {
        tenantId: t.id, message: err?.message || String(err),
      });
    }
  }
  try {
    const svc = deps.notificationsService || notificationsService;
    const res = await svc.archiveOldNotifications({ now: deps.now ? new Date(deps.now) : new Date() });
    out.archived = res.archived;
  } catch (err) {
    log.warn('[notifications] archive pass failed (non-fatal)', { message: err?.message || String(err) });
  }
  return out;
}

async function tick() {
  // KILL-SWITCH — re-read the flag every tick.
  if (!enabled()) {
    logger.info('[notifications] sweep skipped — NOTIFICATIONS_SWEEP_ENABLED is off');
    sweepTimer = null;
    return;
  }
  if (sweepInProgress) {
    logger.info('[notifications] sweep skipped — already running');
    return;
  }
  sweepInProgress = true;
  try {
    const out = await sweepOnce();
    logger.info('[notifications] sweep done', out);
  } catch (err) {
    logger.error('[notifications] sweep failed', { err: err?.message || String(err) });
  } finally {
    sweepInProgress = false;
    if (enabled()) {
      sweepTimer = setTimeout(() => tick().catch(() => null), msUntilNextRun());
      if (sweepTimer.unref) sweepTimer.unref();
    } else {
      sweepTimer = null;
    }
  }
}

export function startNotificationsSweepScheduler() {
  if (!enabled()) {
    logger.info('[notifications] sweep scheduler disabled (NOTIFICATIONS_SWEEP_ENABLED=false)');
    return;
  }
  if (sweepTimer) return;
  const delay = msUntilNextRun();
  sweepTimer = setTimeout(() => tick().catch(() => null), delay);
  if (sweepTimer.unref) sweepTimer.unref();
  logger.info(
    `[notifications] sweep scheduler started — daily at ${SWEEP_HOUR_UTC}:${String(SWEEP_MINUTE_UTC).padStart(2, '0')} UTC, next run in ~${Math.round(delay / 3600000)}h`,
  );
}

export function stopNotificationsSweepScheduler() {
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
}

// Exported for tests / manual triggering.
export const _internal = { tick, msUntilNextRun, sweepOnce };
