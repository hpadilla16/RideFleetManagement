/**
 * Mex (TSD RezCentral) autonomous sync scheduler.
 *
 * Thin wrapper over the shared booking-source scheduler factory. Each sweep
 * enumerates ACTIVE tenants that (a) have the per-tenant master switch ON
 * (Tenant.integrationConfig.mex.enabled === true), (b) have an Mex
 * IntegrationCredential, AND (c) have >= 1 enabled MexLocationConfig,
 * then enqueues ONE mex.sync job per tenant.
 *
 * Autonomy: the worker logs into TSD over plain HTTP (no CAPTCHA — recon Fase 0)
 * and re-logs-in on expiry on its own; navigation goes by menu postback so the
 * single-window session is never broken. No human step.
 *
 * Feature flag MEX_INTEGRATION_ENABLED (default false → SHIP DARK) gates
 * BOTH the worker registration (in worker.js) and this scheduler (inside start()).
 *
 * See doc/mex-integration-plan-2026-07-13.md
 */

import { prisma } from '../../../lib/prisma.js';
import { createSyncScheduler } from '../booking-source/scheduler-factory.js';
import { enqueueOneOffSync } from './mex.worker.js';
import { SOURCE_SYSTEM } from './mex.constants.js';

const scheduler = createSyncScheduler({
  envPrefix: 'MEX',
  sourceSystem: SOURCE_SYSTEM,
  configKey: 'mex',
  logPrefix: '[mex]',
  // Subset of tenantIds with >= 1 enabled (TSD account, branch) config.
  hasEnabledConfig: async (tenantIds) => {
    const rows = await prisma.mexLocationConfig.findMany({
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
export const runMexSyncSweep = scheduler.runSweep;

export function startMexSyncScheduler() {
  scheduler.start();
}

export function stopMexSyncScheduler() {
  scheduler.stop();
}
