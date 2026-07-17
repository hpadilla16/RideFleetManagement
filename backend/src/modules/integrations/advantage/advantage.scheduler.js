/**
 * Advantage (TSD RezCentral) autonomous sync scheduler.
 *
 * Thin wrapper over the shared booking-source scheduler factory. Each sweep
 * enumerates ACTIVE tenants that (a) have the per-tenant master switch ON
 * (Tenant.integrationConfig.advantage.enabled === true), (b) have an Advantage
 * IntegrationCredential, AND (c) have >= 1 enabled AdvantageLocationConfig,
 * then enqueues ONE advantage.sync job per tenant.
 *
 * Autonomy: the worker logs into TSD over plain HTTP (no CAPTCHA — recon Fase 0)
 * and re-logs-in on expiry on its own; navigation goes by menu postback so the
 * single-window session is never broken. No human step.
 *
 * Feature flag ADVANTAGE_INTEGRATION_ENABLED (default false → SHIP DARK) gates
 * BOTH the worker registration (in worker.js) and this scheduler (inside start()).
 *
 * See doc/advantage-integration-plan-2026-07-13.md
 */

import { prisma } from '../../../lib/prisma.js';
import { createSyncScheduler } from '../booking-source/scheduler-factory.js';
import { enqueueOneOffSync } from './advantage.worker.js';
import { SOURCE_SYSTEM } from './advantage.constants.js';

const scheduler = createSyncScheduler({
  envPrefix: 'ADVANTAGE',
  sourceSystem: SOURCE_SYSTEM,
  configKey: 'advantage',
  logPrefix: '[advantage]',
  // Subset of tenantIds with >= 1 enabled (TSD account, branch) config.
  hasEnabledConfig: async (tenantIds) => {
    const rows = await prisma.advantageLocationConfig.findMany({
      where: { tenantId: { in: tenantIds }, enabled: true },
      select: { tenantId: true },
    });
    return rows.map((r) => r.tenantId);
  },
  enqueue: (tenantId, triggeredBy) => enqueueOneOffSync(tenantId, triggeredBy),
});

// Public surface (mirror flexways.scheduler.js names so worker.js wiring is uniform).
export const integrationEnabled = scheduler.integrationEnabled;
export const masterEnabledFromConfig = scheduler.masterEnabledFromConfig;
export const enumerateActiveTenants = scheduler.enumerateActiveTenants;
export const runAdvantageSyncSweep = scheduler.runSweep;

export function startAdvantageSyncScheduler() {
  scheduler.start();
}

export function stopAdvantageSyncScheduler() {
  scheduler.stop();
}
