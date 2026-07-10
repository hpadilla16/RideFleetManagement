/**
 * NU Car Rentals (affiliates portal) autonomous sync scheduler.
 *
 * Mirrors the Economy scheduler: a setInterval loop with a startup delay and an
 * in-progress guard. Each sweep enumerates the ACTIVE tenants that (a) have the
 * per-tenant master switch ON (Tenant.integrationConfig.nu.enabled === true),
 * (b) have an NU IntegrationCredential, AND (c) have ≥1 enabled NuLocationConfig,
 * then enqueues ONE nu.sync job per tenant.
 *
 * Autonomy: NU has no IP-binding / proxy (confirmed 2026-07-09 PoC from the NYC
 * droplet), so this runs unattended — the worker logs in and re-logs-in on
 * expiry on its own.
 *
 * Feature flag NU_INTEGRATION_ENABLED (default false → ship dark) gates BOTH the
 * worker registration (in worker.js) and this scheduler.
 *
 * See doc/nu-integration-plan-2026-07-09.md
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { enqueueOneOffSync } from './nu.worker.js';
import { SOURCE_SYSTEM } from './nu.constants.js';

const DEFAULT_STARTUP_DELAY_SECONDS = 60;

let nuSyncTimer = null;
let nuStartupTimer = null;
let nuSweepInProgress = false;

export function integrationEnabled() {
  return String(process.env.NU_INTEGRATION_ENABLED || 'false').toLowerCase() === 'true';
}

function syncIntervalMs() {
  const minutes = Number(process.env.NU_SYNC_INTERVAL_MINUTES || 15);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
}

function startupDelayMs() {
  const seconds = Number(process.env.NU_SYNC_STARTUP_DELAY_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}

/**
 * Read the per-tenant master switch from Tenant.integrationConfig.nu.enabled.
 * Default false → dark. Exported for tests.
 */
export function masterEnabledFromConfig(integrationConfig) {
  return !!(
    integrationConfig
    && typeof integrationConfig === 'object'
    && integrationConfig.nu
    && integrationConfig.nu.enabled === true
  );
}

/**
 * Enumerate the (tenant) targets: active tenants that (a) have the per-tenant
 * master switch ON, (b) have an NU credential, AND (c) have ≥1 enabled
 * NuLocationConfig. Returns an array of tenantId strings. Exported for tests.
 *
 * The NU_INTEGRATION_ENABLED env flag remains the GLOBAL gate on top of this
 * per-tenant flag (checked by startNuSyncScheduler before any sweep runs).
 */
export async function enumerateActiveTenants() {
  const creds = await prisma.integrationCredential.findMany({
    where: {
      sourceSystem: SOURCE_SYSTEM,
      tenant: { status: 'ACTIVE' },
    },
    select: { tenantId: true, tenant: { select: { integrationConfig: true } } },
  });
  if (creds.length === 0) return [];

  const masterOn = creds.filter((c) => masterEnabledFromConfig(c.tenant?.integrationConfig));
  const tenantIds = Array.from(new Set(masterOn.map((c) => c.tenantId)));
  if (tenantIds.length === 0) return [];

  const withConfig = await prisma.nuLocationConfig.findMany({
    where: { tenantId: { in: tenantIds }, enabled: true },
    select: { tenantId: true },
  });
  const enabledSet = new Set(withConfig.map((c) => c.tenantId));
  return tenantIds.filter((id) => enabledSet.has(id));
}

export async function runNuSyncSweep() {
  if (nuSweepInProgress) {
    logger.info('[nu] sync sweep skipped because one is already running');
    return { skipped: true };
  }
  nuSweepInProgress = true;
  try {
    const tenantIds = await enumerateActiveTenants();
    let enqueued = 0;
    for (const tenantId of tenantIds) {
      try {
        await enqueueOneOffSync(tenantId, 'schedule');
        enqueued++;
      } catch (err) {
        logger.warn('[nu] failed to enqueue sync job', { tenantId, message: err.message });
      }
    }
    logger.info(`[nu] sync sweep enqueued ${enqueued}/${tenantIds.length} tenant(s)`);
    return { processedTenants: tenantIds.length, enqueued };
  } catch (error) {
    logger.error('[nu] sync sweep failed', { message: error.message, stack: error.stack });
    return { error: error.message };
  } finally {
    nuSweepInProgress = false;
  }
}

export function startNuSyncScheduler() {
  if (!integrationEnabled()) {
    logger.info('[nu] integration disabled (NU_INTEGRATION_ENABLED != true) — scheduler not started');
    return;
  }
  if (nuSyncTimer || nuStartupTimer) return; // already started

  nuStartupTimer = setTimeout(() => {
    runNuSyncSweep().catch(() => null);
  }, startupDelayMs());

  nuSyncTimer = setInterval(() => {
    runNuSyncSweep().catch(() => null);
  }, syncIntervalMs());

  logger.info(`[nu] sync scheduler started every ${Math.round(syncIntervalMs() / 60000)} minute(s)`);
}

export function stopNuSyncScheduler() {
  if (nuStartupTimer) {
    clearTimeout(nuStartupTimer);
    nuStartupTimer = null;
  }
  if (nuSyncTimer) {
    clearInterval(nuSyncTimer);
    nuSyncTimer = null;
  }
}
