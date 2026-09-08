/**
 * Advantage-by-email autonomous poll scheduler.
 *
 * Thin wrapper over the shared booking-source scheduler factory, so this
 * transport gets the same startup delay, the same in-progress guard and the
 * same three-part gate every scraper has. Each sweep enumerates ACTIVE tenants
 * that (a) have the per-tenant master switch ON
 * (Tenant.integrationConfig.advantageEmail.enabled === true), (b) have an
 * 'ADVANTAGE_EMAIL' IntegrationCredential (the mailbox), AND (c) have >= 1
 * enabled AdvantageLocationConfig, then enqueues ONE advantage-email.sync job
 * per tenant.
 *
 * WHY (c) IS THE SAME TABLE THE SCRAPER USES. A message routes on the
 * (tsdNumber, branch) pair its masthead and Pickup/Return carry, and that pair
 * is what AdvantageLocationConfig has always been keyed on. With no enabled
 * config there is no branch to route to, so every message would quarantine —
 * polling a mailbox to reject everything in it is not a useful default.
 *
 * Feature flag ADVANTAGE_EMAIL_INTEGRATION_ENABLED (default false → SHIP DARK)
 * gates BOTH the worker registration (in worker.js) and this scheduler (inside
 * start()). Nothing polls anybody's mailbox until it is flipped.
 *
 * See doc/advantage-email-ingestion-2026-09-08.md
 */

import { prisma } from '../../../lib/prisma.js';
import { createSyncScheduler } from '../booking-source/scheduler-factory.js';
import { enqueueOneOffSync } from './advantage-email.worker.js';
import { CREDENTIAL_SOURCE_SYSTEM, CONFIG_KEY, ENV_PREFIX, LOG_PREFIX } from './advantage-email.constants.js';

const scheduler = createSyncScheduler({
  envPrefix: ENV_PREFIX,
  // The scheduler looks for the MAILBOX credential, not the portal login.
  sourceSystem: CREDENTIAL_SOURCE_SYSTEM,
  configKey: CONFIG_KEY,
  logPrefix: LOG_PREFIX,
  hasEnabledConfig: async (tenantIds) => {
    const rows = await prisma.advantageLocationConfig.findMany({
      where: { tenantId: { in: tenantIds }, enabled: true },
      select: { tenantId: true },
    });
    return rows.map((r) => r.tenantId);
  },
  enqueue: (tenantId, triggeredBy) => enqueueOneOffSync(tenantId, triggeredBy),
});

// Public surface — mirrors advantage.scheduler.js so worker.js wiring is uniform.
export const integrationEnabled = scheduler.integrationEnabled;
export const masterEnabledFromConfig = scheduler.masterEnabledFromConfig;
export const enumerateActiveTenants = scheduler.enumerateActiveTenants;
export const runAdvantageEmailSweep = scheduler.runSweep;

export function startAdvantageEmailScheduler() {
  scheduler.start();
}

export function stopAdvantageEmailScheduler() {
  scheduler.stop();
}
