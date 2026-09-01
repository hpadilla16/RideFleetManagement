// Idle-vehicle daily sweep (2026-09-01, backlog #5). Same scheduler family as
// notifications.scheduler.js (fixed daily UTC time, default-ON opt-out env
// flag, worker.js dynamic-import registration) — NOT a new cron mechanism.
//
// Daily at 09:20 UTC — the 09:10 notifications-sweep family, staggered by 10
// minutes so the two never contend. Two gates, in order:
//   1. IDLE_VEHICLE_SWEEP_ENABLED (env, default ON) — ops kill-switch.
//   2. Per-tenant idleVehicleConfig.enabled (AppSetting, default OFF) — the
//      real gate. The sweep is a NO-OP for every tenant until one opts in
//      from Settings, so shipping this is inert (shuttle-tracker precedent).

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { sweepIdleVehiclesForTenant } from './idle-vehicle.service.js';

const SWEEP_HOUR_UTC = 9;
const SWEEP_MINUTE_UTC = 20;

let sweepTimer = null;
let sweepInProgress = false;

export function enabled() {
  return String(process.env.IDLE_VEHICLE_SWEEP_ENABLED || 'true').toLowerCase() !== 'false';
}

export function msUntilNextRun(now = new Date()) {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    SWEEP_HOUR_UTC, SWEEP_MINUTE_UTC, 0, 0,
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/** The whole sweep. Exported for tests / manual triggering. */
export async function sweepIdleOnce(deps = {}) {
  const db = deps.prisma || deps.db || prisma;
  const log = deps.logger || logger;
  const tenants = await db.tenant.findMany({ select: { id: true } });
  const out = { tenants: tenants.length, enabledTenants: 0, emitted: 0, resolved: 0 };
  for (const t of tenants) {
    // Per-tenant try/catch: one bad tenant never aborts the sweep.
    try {
      const res = await sweepIdleVehiclesForTenant(t.id, { ...deps, db });
      if (!res.skipped) {
        out.enabledTenants += 1;
        out.emitted += res.emitted;
        out.resolved += res.resolved;
      }
    } catch (err) {
      log.warn('[idle-vehicle] sweep failed for tenant (continuing)', {
        tenantId: t.id, message: err?.message || String(err),
      });
    }
  }
  return out;
}

async function tick() {
  // KILL-SWITCH — re-read the flag every tick.
  if (!enabled()) {
    logger.info('[idle-vehicle] sweep skipped — IDLE_VEHICLE_SWEEP_ENABLED is off');
    sweepTimer = null;
    return;
  }
  if (sweepInProgress) {
    logger.info('[idle-vehicle] sweep skipped — already running');
    return;
  }
  sweepInProgress = true;
  try {
    const out = await sweepIdleOnce();
    logger.info('[idle-vehicle] sweep done', out);
  } catch (err) {
    logger.error('[idle-vehicle] sweep failed', { err: err?.message || String(err) });
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

export function startIdleVehicleSweepScheduler() {
  if (!enabled()) {
    logger.info('[idle-vehicle] sweep scheduler disabled (IDLE_VEHICLE_SWEEP_ENABLED=false)');
    return;
  }
  if (sweepTimer) return;
  const delay = msUntilNextRun();
  sweepTimer = setTimeout(() => tick().catch(() => null), delay);
  if (sweepTimer.unref) sweepTimer.unref();
  logger.info(
    `[idle-vehicle] sweep scheduler started — daily at ${SWEEP_HOUR_UTC}:${String(SWEEP_MINUTE_UTC).padStart(2, '0')} UTC, next run in ~${Math.round(delay / 3600000)}h`,
  );
}

export function stopIdleVehicleSweepScheduler() {
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
}

// Exported for tests / manual triggering.
export const _internal = { tick, msUntilNextRun, sweepIdleOnce };
