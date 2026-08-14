/**
 * Voltswitch sync due-logic — the pure half of the scheduler.
 *
 * One definition, two consumers: the worker's tick loop asks it "is this
 * tenant due?", and the test suite asks it the same question with a fake
 * clock. The scheduler file owns timers and Prisma; this file owns the
 * decision, so the decision is testable on Windows without a database
 * (house pattern: tolls-queue-counts, view-location, backdated-return).
 *
 * A tenant is due when ALL of:
 *   - telematics is usable at all (config.ready: enabled + included in plan);
 *   - the Voltswitch connector is fully configured (provider VOLTSWITCH,
 *     connector allowed, credentials present) — voltswitchConnectorReady;
 *   - at least voltswitchSyncIntervalMinutes have passed since the last
 *     ATTEMPT (not the last success: a tenant whose sync errors must not
 *     collapse into a tight retry loop against Voltswitch's API).
 */

/** Clamp mirror of settings normalization — never trust a raw config blob. */
function intervalMs(config) {
  const min = Math.max(1, Math.min(60, Number(config?.voltswitchSyncIntervalMinutes) || 5));
  return min * 60 * 1000;
}

/**
 * @param {{config: object, lastAttemptAt: number|null|undefined, now: number}} args
 * @returns {boolean}
 */
export function isVoltswitchSyncDue({ config, lastAttemptAt = null, now = Date.now() } = {}) {
  if (!config?.ready) return false;
  if (!config?.voltswitchConnectorReady) return false;
  if (lastAttemptAt == null || Number.isNaN(Number(lastAttemptAt))) return true;
  return (now - Number(lastAttemptAt)) >= intervalMs(config);
}

/**
 * Extract the tenantId from a scoped AppSetting key. Only the tenant-scoped
 * form counts: the global (unscoped) telematicsConfig row has no tenant to
 * sync and is ignored on purpose.
 *
 * @param {string} key e.g. "tenant:cmb123:telematicsConfig"
 * @returns {string|null}
 */
export function tenantIdFromTelematicsKey(key) {
  const m = /^tenant:(.+):telematicsConfig$/.exec(String(key || ''));
  return m ? m[1] : null;
}
