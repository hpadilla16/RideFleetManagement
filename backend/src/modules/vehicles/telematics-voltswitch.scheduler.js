/**
 * Voltswitch periodic sync — the worker half of the pull-based connector.
 *
 * The Voltswitch client, the sync service (device upsert + VIN/plate match +
 * location ingest) and the manual POST /telematics/voltswitch/sync route all
 * existed; what never existed was anything PERIODIC — the
 * voltswitchSyncIntervalMinutes setting was written and read by nobody. This
 * scheduler is that missing consumer.
 *
 * Shape mirrors citation-ocr / checkin-email schedulers: a setInterval tick
 * in the worker process, an overlap guard, and a per-tenant due check. The
 * due DECISION lives in voltswitch-sync-due.js (pure, tested); this file
 * only owns timers and IO.
 *
 * Tenant discovery is by AppSetting key shape (tenant:<id>:telematicsConfig)
 * rather than scanning every tenant: only tenants that ever SAVED telematics
 * settings can possibly be configured, and that list is tiny.
 *
 * Every tenant sync is bounded by withTimeout — the 2026-08-08 incident rule:
 * an awaited external call without a deadline eventually hangs the loop that
 * awaits it. One slow tenant must not stall the others, so failures are
 * caught per-tenant and the loop continues.
 */
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { withTimeout } from '../../lib/with-timeout.js';
import { settingsService } from '../settings/settings.service.js';
import { vehiclesService } from './vehicles.service.js';
import { isVoltswitchSyncDue, tenantIdFromTelematicsKey } from './voltswitch-sync-due.js';
import { checkOverdueVehiclesForTenant } from './overdue-locate.service.js';

const TICK_MS = Math.max(30 * 1000, parseInt(process.env.VOLTSWITCH_TICK_MS || String(60 * 1000), 10) || 60 * 1000);
const SYNC_TIMEOUT_MS = Math.max(30 * 1000, parseInt(process.env.VOLTSWITCH_SYNC_TIMEOUT_MS || String(120 * 1000), 10) || 120 * 1000);

let timerHandle = null;
let running = false;
// tenantId -> epoch ms of the last sync ATTEMPT (success or failure).
const lastAttemptAt = new Map();

async function tick() {
  if (running) return; // a slow pass must not stack a second one on top
  running = true;
  try {
    const rows = await prisma.appSetting.findMany({
      where: { key: { endsWith: ':telematicsConfig' } },
      select: { key: true },
    });

    for (const row of rows) {
      const tenantId = tenantIdFromTelematicsKey(row.key);
      if (!tenantId) continue;

      let config;
      try {
        config = await settingsService.getTelematicsConfig({ tenantId });
      } catch (err) {
        logger.warn('[voltswitch] config read failed', { tenantId, message: err.message });
        continue;
      }

      if (!isVoltswitchSyncDue({ config, lastAttemptAt: lastAttemptAt.get(tenantId), now: Date.now() })) continue;

      lastAttemptAt.set(tenantId, Date.now());
      try {
        const result = await withTimeout(
          vehiclesService.syncVoltswitchDevices({ tenantId }),
          SYNC_TIMEOUT_MS,
          `voltswitch sync tenant ${tenantId}`
        );
        logger.info('[voltswitch] sync complete', {
          tenantId,
          synced: result?.synced ?? 0,
          skipped: result?.skipped ?? 0,
          errors: result?.errors?.length ?? 0,
        });
      } catch (err) {
        logger.warn('[voltswitch] sync failed', { tenantId, message: err.message });
      }

      // Overdue geofence check (2026-08-13) — same cadence, own failure
      // domain: a broken overdue sweep must not stop device sync (or vice
      // versa; the sync's catch above already guarantees that direction).
      try {
        const configWithSecret = await settingsService.getTelematicsConfig({ tenantId }, { includeSecret: true });
        const overdueResult = await withTimeout(
          checkOverdueVehiclesForTenant({ tenantId, config: configWithSecret }),
          SYNC_TIMEOUT_MS,
          `voltswitch overdue check tenant ${tenantId}`
        );
        if (overdueResult.checked || overdueResult.outside || overdueResult.resolved) {
          logger.info('[voltswitch] overdue check', { tenantId, ...overdueResult });
        }
      } catch (err) {
        logger.warn('[voltswitch] overdue check failed', { tenantId, message: err.message });
      }
    }
  } catch (err) {
    logger.warn('[voltswitch] tick failed', { message: err.message });
  } finally {
    running = false;
  }
}

export function startVoltswitchScheduler() {
  if (timerHandle) return;
  timerHandle = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timerHandle.unref) timerHandle.unref();
  // First pass shortly after boot so a deploy doesn't wait a full interval.
  setTimeout(() => { tick().catch(() => {}); }, 15 * 1000).unref?.();
  logger.info('[voltswitch] scheduler started', { tickMs: TICK_MS });
}

export function stopVoltswitchScheduler() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}
