/**
 * Shared sync-scheduler factory for booking-source integrations
 * (R0 extraction, 2026-07-13).
 *
 * nu.scheduler.js and economy.scheduler.js are ~95% identical: a setInterval
 * loop with a startup delay and an in-progress guard; each sweep enumerates
 * ACTIVE tenants that (a) have the per-tenant master switch ON
 * (Tenant.integrationConfig[configKey].enabled === true), (b) have a source
 * IntegrationCredential, AND (c) have ≥1 enabled per-source location config,
 * then enqueues ONE sync job per tenant. The per-source bits are the env
 * prefix, the sourceSystem, the integrationConfig key, the location-config
 * model (absorbed by the hasEnabledConfig callback) and the enqueue function.
 *
 * The `${envPrefix}_INTEGRATION_ENABLED` env flag (default false → ship dark)
 * remains the GLOBAL gate on top of the per-tenant flag, checked by start().
 *
 * NOT wired into economy/nu yet — R0 ships the shared code + tests only.
 */

import { prisma } from '../../../lib/prisma.js';
import logger from '../../../lib/logger.js';

const DEFAULT_STARTUP_DELAY_SECONDS = 60;
const DEFAULT_INTERVAL_MINUTES = 15;

/**
 * @param {{
 *   envPrefix: string,          // 'NU' | 'ECONOMY' → *_INTEGRATION_ENABLED etc.
 *   sourceSystem: string,       // IntegrationCredential.sourceSystem value
 *   configKey: string,          // Tenant.integrationConfig key ('nu' | 'economy')
 *   logPrefix: string,          // '[nu]' | '[economy]'
 *   hasEnabledConfig: (tenantIds: string[]) => Promise<Iterable<string>>,
 *                               // subset of tenantIds with ≥1 enabled location config
 *   enqueue: (tenantId: string, triggeredBy: string) => Promise<any>,
 *   prismaClient?: object,
 * }} spec
 * @returns {{ integrationEnabled, masterEnabledFromConfig, enumerateActiveTenants,
 *             runSweep, start, stop }}
 */
export function createSyncScheduler(spec) {
  const {
    envPrefix,
    sourceSystem,
    configKey,
    logPrefix,
    hasEnabledConfig,
    enqueue,
    prismaClient = prisma,
  } = spec || {};

  if (!envPrefix) throw new Error('createSyncScheduler: envPrefix required');
  if (!sourceSystem) throw new Error('createSyncScheduler: sourceSystem required');
  if (!configKey) throw new Error('createSyncScheduler: configKey required');
  if (typeof hasEnabledConfig !== 'function') throw new Error('createSyncScheduler: hasEnabledConfig required');
  if (typeof enqueue !== 'function') throw new Error('createSyncScheduler: enqueue required');

  // Per-instance timer/guard state (module-level lets in the originals).
  let syncTimer = null;
  let startupTimer = null;
  let sweepInProgress = false;

  function integrationEnabled() {
    return String(process.env[`${envPrefix}_INTEGRATION_ENABLED`] || 'false').toLowerCase() === 'true';
  }

  function syncIntervalMs() {
    const minutes = Number(process.env[`${envPrefix}_SYNC_INTERVAL_MINUTES`] || DEFAULT_INTERVAL_MINUTES);
    return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
  }

  function startupDelayMs() {
    const seconds = Number(process.env[`${envPrefix}_SYNC_STARTUP_DELAY_SECONDS`] || DEFAULT_STARTUP_DELAY_SECONDS);
    return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
  }

  // Per-tenant master switch: Tenant.integrationConfig[configKey].enabled.
  // Default false → dark.
  function masterEnabledFromConfig(integrationConfig) {
    return !!(
      integrationConfig
      && typeof integrationConfig === 'object'
      && integrationConfig[configKey]
      && integrationConfig[configKey].enabled === true
    );
  }

  // Active tenants with (a) master switch ON, (b) a source credential, and
  // (c) ≥1 enabled location config (via the per-source callback).
  async function enumerateActiveTenants() {
    const creds = await prismaClient.integrationCredential.findMany({
      where: {
        sourceSystem,
        tenant: { status: 'ACTIVE' },
      },
      select: { tenantId: true, tenant: { select: { integrationConfig: true } } },
    });
    if (creds.length === 0) return [];

    const masterOn = creds.filter((c) => masterEnabledFromConfig(c.tenant?.integrationConfig));
    const tenantIds = Array.from(new Set(masterOn.map((c) => c.tenantId)));
    if (tenantIds.length === 0) return [];

    const enabledSet = new Set(await hasEnabledConfig(tenantIds));
    return tenantIds.filter((id) => enabledSet.has(id));
  }

  async function runSweep() {
    if (sweepInProgress) {
      logger.info(`${logPrefix} sync sweep skipped because one is already running`);
      return { skipped: true };
    }
    sweepInProgress = true;
    try {
      const tenantIds = await enumerateActiveTenants();
      let enqueued = 0;
      for (const tenantId of tenantIds) {
        try {
          await enqueue(tenantId, 'schedule');
          enqueued++;
        } catch (err) {
          logger.warn(`${logPrefix} failed to enqueue sync job`, { tenantId, message: err.message });
        }
      }
      logger.info(`${logPrefix} sync sweep enqueued ${enqueued}/${tenantIds.length} tenant(s)`);
      return { processedTenants: tenantIds.length, enqueued };
    } catch (error) {
      logger.error(`${logPrefix} sync sweep failed`, { message: error.message, stack: error.stack });
      return { error: error.message };
    } finally {
      sweepInProgress = false;
    }
  }

  function start() {
    if (!integrationEnabled()) {
      logger.info(`${logPrefix} integration disabled (${envPrefix}_INTEGRATION_ENABLED != true) — scheduler not started`);
      return;
    }
    if (syncTimer || startupTimer) return; // already started

    startupTimer = setTimeout(() => {
      runSweep().catch(() => null);
    }, startupDelayMs());

    syncTimer = setInterval(() => {
      runSweep().catch(() => null);
    }, syncIntervalMs());

    logger.info(`${logPrefix} sync scheduler started every ${Math.round(syncIntervalMs() / 60000)} minute(s)`);
  }

  function stop() {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
  }

  return {
    integrationEnabled,
    masterEnabledFromConfig,
    enumerateActiveTenants,
    runSweep,
    start,
    stop,
  };
}
