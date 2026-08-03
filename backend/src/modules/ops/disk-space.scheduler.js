/**
 * Disk-space watchdog (2026-08-03).
 *
 * WHY: the production droplet reached 154G/154G — 0 bytes free. Requests that
 * needed to write anything failed at the network layer, so users saw a bare
 * "Failed to fetch" while the application logs stayed EMPTY: the server could
 * not write the line describing its own failure. There was no signal until a
 * human reported a broken screen. This closes that blind spot — it warns while
 * there is still room to act, and the warning goes to Sentry (not just stdout)
 * because nobody watches container logs continuously.
 *
 * Reads the filesystem backing the container, which on overlay2 is the host's
 * disk — the number that actually matters. statfs via `df` is intentionally
 * avoided: spawning a shell from a long-lived worker is a worse failure mode
 * than a missing metric, so we use fs.statfs and simply stay silent if the
 * platform does not support it.
 *
 * Env:
 *   DISK_ALERT_PCT              warn at/above this usage (default 80)
 *   DISK_CHECK_INTERVAL_MINUTES how often to look (default 60)
 *   DISK_CHECK_ENABLED=false    turn the watchdog off entirely
 */

import { statfs } from 'node:fs/promises';
import logger from '../../lib/logger.js';
import { captureBackendException } from '../../lib/sentry.js';

const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_ALERT_PCT = 80;
const GB = 1024 ** 3;

let timer = null;
// Re-alert at most once per escalation so a full disk does not fire an alert
// every hour for days; a drop back under the threshold re-arms it.
let alerting = false;

function enabled() {
  return String(process.env.DISK_CHECK_ENABLED || 'true').toLowerCase() !== 'false';
}
function alertPct() {
  const n = Number(process.env.DISK_ALERT_PCT || DEFAULT_ALERT_PCT);
  return Number.isFinite(n) && n > 0 && n < 100 ? n : DEFAULT_ALERT_PCT;
}
function intervalMs() {
  const n = Number(process.env.DISK_CHECK_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MINUTES) * 60 * 1000;
}

/** Current usage of the filesystem holding `path`. Pure-ish; exported for tests. */
export async function readDiskUsage(path = '/') {
  const s = await statfs(path);
  const total = s.blocks * s.bsize;
  // bavail = blocks free to UNPRIVILEGED users; bfree includes root's reserve
  // and would make a disk that is already refusing writes look healthy.
  const available = s.bavail * s.bsize;
  const used = total - available;
  return {
    totalGb: +(total / GB).toFixed(1),
    availableGb: +(available / GB).toFixed(1),
    usedPct: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}

export async function checkDiskOnce(deps = {}) {
  const read = deps.readDiskUsage || readDiskUsage;
  const capture = deps.capture || captureBackendException;
  const threshold = deps.alertPct ?? alertPct();
  let usage;
  try {
    usage = await read('/');
  } catch (err) {
    logger.warn('[disk-check] could not read filesystem stats', { message: err.message });
    return null;
  }

  if (usage.usedPct >= threshold) {
    if (!alerting) {
      alerting = true;
      const msg = `Disk ${usage.usedPct}% full — only ${usage.availableGb}GB free of ${usage.totalGb}GB`;
      logger.error(`[disk-check] ${msg}`, usage);
      // An Error (not a message) so it lands in Sentry's issue stream with a
      // stack, groups across firings, and can be alerted on like any other.
      capture(new Error(`[ops] ${msg}`), {
        ops: { ...usage, threshold, hint: 'run scripts/ops/droplet-disk-maintenance.sh' },
      });
    }
  } else if (alerting) {
    alerting = false;
    logger.info('[disk-check] disk back under threshold', usage);
  }
  return usage;
}

export function startDiskCheckScheduler() {
  if (!enabled()) {
    logger.info('[disk-check] watchdog disabled (DISK_CHECK_ENABLED=false)');
    return;
  }
  if (timer) return;
  // Check once at boot: a disk that filled while the worker was down should
  // not wait a full interval to be noticed.
  checkDiskOnce().catch(() => {});
  timer = setInterval(() => { checkDiskOnce().catch(() => {}); }, intervalMs());
  logger.info(`[disk-check] watchdog started — every ${Math.round(intervalMs() / 60000)} min, alert at ${alertPct()}%`);
}

export function stopDiskCheckScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/** Test seam: forget that we already alerted. */
export function _resetDiskAlertState() { alerting = false; }
