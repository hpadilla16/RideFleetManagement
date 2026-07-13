/**
 * Flexways (MobilityPS) autonomous sync scheduler.
 *
 * Thin wrapper over the shared booking-source scheduler factory. Each sweep
 * enumerates ACTIVE tenants that (a) have the per-tenant master switch ON
 * (Tenant.integrationConfig.flexways.enabled === true), (b) have a Flexways
 * IntegrationCredential, AND (c) have >= 1 enabled FlexwaysLocationConfig (sede),
 * then enqueues ONE flexways.sync job per tenant.
 *
 * Autonomy: the worker logs in headlessly (reCAPTCHA v3 runs in-page) and
 * re-logs-in on expiry on its own — no human step.
 *
 * Feature flag FLEXWAYS_INTEGRATION_ENABLED (default false → ship dark) gates BOTH
 * the worker registration (in worker.js) and this scheduler (inside start()).
 *
 * See doc/flexways-integration-plan-2026-07-13.md
 */

import { prisma } from '../../../lib/prisma.js';
import { createSyncScheduler } from '../booking-source/scheduler-factory.js';
import { enqueueOneOffSync } from './flexways.worker.js';
import { SOURCE_SYSTEM } from './flexways.constants.js';

const scheduler = createSyncScheduler({
  envPrefix: 'FLEXWAYS',
  sourceSystem: SOURCE_SYSTEM,
  configKey: 'flexways',
  logPrefix: '[flexways]',
  // Subset of tenantIds with >= 1 enabled sede config.
  hasEnabledConfig: async (tenantIds) => {
    const rows = await prisma.flexwaysLocationConfig.findMany({
      where: { tenantId: { in: tenantIds }, enabled: true },
      select: { tenantId: true },
    });
    return rows.map((r) => r.tenantId);
  },
  enqueue: (tenantId, triggeredBy) => enqueueOneOffSync(tenantId, triggeredBy),
});

// Public surface (mirror nu.scheduler.js names so worker.js wiring is uniform).
export const integrationEnabled = scheduler.integrationEnabled;
export const masterEnabledFromConfig = scheduler.masterEnabledFromConfig;
export const enumerateActiveTenants = scheduler.enumerateActiveTenants;
export const runFlexwaysSyncSweep = scheduler.runSweep;

export function startFlexwaysSyncScheduler() {
  scheduler.start();
}

export function stopFlexwaysSyncScheduler() {
  scheduler.stop();
}
