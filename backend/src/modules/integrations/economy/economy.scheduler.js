/**
 * Economy (RezLight) autonomous sync scheduler.
 *
 * Mirrors the tolls scheduler shape: a setInterval loop with a startup delay
 * and an in-progress guard. Each sweep enumerates the ACTIVE tenants that (a)
 * have an ECONOMY IntegrationCredential AND (b) at least one enabled
 * EconomyLocationConfig, then enqueues ONE economy.sync job per tenant (the
 * worker fans out across that tenant's enabled areas internally, since one
 * credential + one list call covers every area).
 *
 * Autonomy: Economy has no IP-binding / proxy (confirmed 2026-07-05), so this
 * runs unattended — the worker logs in and re-logs-in on expiry on its own.
 *
 * Feature flag ECONOMY_INTEGRATION_ENABLED (default false → ship dark) gates
 * BOTH the worker registration (in worker.js) and this scheduler.
 *
 * See doc/economy-integration-plan-2026-07-05.md
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';
import { enqueueOneOffSync } from './economy.worker.js';
import { SOURCE_SYSTEM } from './economy.constants.js';

const DEFAULT_STARTUP_DELAY_SECONDS = 60;

let economySyncTimer = null;
let economyStartupTimer = null;
let economySweepInProgress = false;

export function integrationEnabled() {
  return String(process.env.ECONOMY_INTEGRATION_ENABLED || 'false').toLowerCase() === 'true';
}

function syncIntervalMs() {
  const minutes = Number(process.env.ECONOMY_SYNC_INTERVAL_MINUTES || 15);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
}

function startupDelayMs() {
  const seconds = Number(process.env.ECONOMY_SYNC_STARTUP_DELAY_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}

/**
 * Read the per-tenant master switch from Tenant.integrationConfig.economy.enabled.
 * Parsed identically to economy.routes.js readMasterEnabled so the scheduler and
 * the panel agree on what "enabled" means. Default false → dark.
 */
export function masterEnabledFromConfig(integrationConfig) {
  return !!(
    integrationConfig
    && typeof integrationConfig === 'object'
    && integrationConfig.economy
    && integrationConfig.economy.enabled === true
  );
}

/**
 * Enumerate the (tenant) targets: active tenants that (a) have the per-tenant
 * master switch ON (Tenant.integrationConfig.economy.enabled === true), (b) have
 * an ECONOMY credential, AND (c) have ≥1 enabled EconomyLocationConfig. Returns
 * an array of tenantId strings. Exported for tests.
 *
 * The ECONOMY_INTEGRATION_ENABLED env flag remains the GLOBAL gate on top of this
 * per-tenant flag (checked by startEconomySyncScheduler before any sweep runs).
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

  // Keep only tenants whose per-tenant master switch is ON.
  const masterOn = creds.filter((c) => masterEnabledFromConfig(c.tenant?.integrationConfig));
  const tenantIds = Array.from(new Set(masterOn.map((c) => c.tenantId)));
  if (tenantIds.length === 0) return [];

  // Keep only tenants that also have ≥1 enabled area config.
  const withConfig = await prisma.economyLocationConfig.findMany({
    where: { tenantId: { in: tenantIds }, enabled: true },
    select: { tenantId: true },
  });
  const enabledSet = new Set(withConfig.map((c) => c.tenantId));
  return tenantIds.filter((id) => enabledSet.has(id));
}

export async function runEconomySyncSweep() {
  if (economySweepInProgress) {
    logger.info('[economy] sync sweep skipped because one is already running');
    return { skipped: true };
  }
  economySweepInProgress = true;
  try {
    const tenantIds = await enumerateActiveTenants();
    let enqueued = 0;
    for (const tenantId of tenantIds) {
      try {
        await enqueueOneOffSync(tenantId, 'schedule');
        enqueued++;
      } catch (err) {
        logger.warn('[economy] failed to enqueue sync job', { tenantId, message: err.message });
      }
    }
    logger.info(`[economy] sync sweep enqueued ${enqueued}/${tenantIds.length} tenant(s)`);
    return { processedTenants: tenantIds.length, enqueued };
  } catch (error) {
    logger.error('[economy] sync sweep failed', { message: error.message, stack: error.stack });
    return { error: error.message };
  } finally {
    economySweepInProgress = false;
  }
}

export function startEconomySyncScheduler() {
  if (!integrationEnabled()) {
    logger.info('[economy] integration disabled (ECONOMY_INTEGRATION_ENABLED != true) — scheduler not started');
    return;
  }
  if (economySyncTimer || economyStartupTimer) return; // already started

  economyStartupTimer = setTimeout(() => {
    runEconomySyncSweep().catch(() => null);
  }, startupDelayMs());

  economySyncTimer = setInterval(() => {
    runEconomySyncSweep().catch(() => null);
  }, syncIntervalMs());

  logger.info(`[economy] sync scheduler started every ${Math.round(syncIntervalMs() / 60000)} minute(s)`);
}

export function stopEconomySyncScheduler() {
  if (economyStartupTimer) {
    clearTimeout(economyStartupTimer);
    economyStartupTimer = null;
  }
  if (economySyncTimer) {
    clearInterval(economySyncTimer);
    economySyncTimer = null;
  }
}
