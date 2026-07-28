/**
 * Outbound rate-push scheduler (2026-07-28, F3). Own timer + in-progress guard,
 * independent of the Economy reservation sync (Hector's rule: one connector
 * never blocks another).
 *
 * WHY a sweep instead of an inline hook after Market Intelligence auto-applies:
 * MI runs in the API container while the push runs in the worker, so an
 * in-process signal could not cross containers, and calling the portal inline
 * would couple MI's write path to a slow third-party HTTP round-trip. Because
 * pushArea skips every cell that already matches (`no_change`), a periodic
 * sweep IS both the MI follow-up and the drift backstop — it converges on the
 * same result with no coupling and no extra state. The interval is therefore
 * the effective settle window: an MI change reaches the franchise within one
 * cycle (default 30 min).
 *
 * DORMANT: startEconomyRatePushScheduler is a no-op while
 * ECONOMY_RATE_PUSH_MODE is OFF (the default).
 */
import logger from '../../../lib/logger.js';
import { MODES, pushMode } from './economy-rate-push.service.js';

let timer = null;
let startupTimer = null;
let inProgress = false;

export function intervalMinutes() {
  const n = Number(process.env.ECONOMY_RATE_PUSH_INTERVAL_MINUTES || 30);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export function startupDelaySeconds() {
  const n = Number(process.env.ECONOMY_RATE_PUSH_STARTUP_DELAY_SECONDS || 240);
  return Number.isFinite(n) && n >= 0 ? n : 240;
}

async function runSweep() {
  if (inProgress) { logger.info('[economy-rate-push] sweep skipped — one already running'); return; }
  inProgress = true;
  try {
    const { pushAllAreas } = await import('./economy-rate-push.service.js');
    const out = await pushAllAreas();
    logger.info('[economy-rate-push] sweep complete', {
      mode: out?.mode, processedAreas: out?.processedAreas ?? 0, skipped: out?.skipped || null,
    });
  } catch (err) {
    logger.error('[economy-rate-push] sweep failed', { message: String(err?.message || err) });
  } finally {
    inProgress = false;
  }
}

export function startEconomyRatePushScheduler() {
  if (pushMode() === MODES.OFF) {
    logger.info('[economy-rate-push] scheduler disabled (ECONOMY_RATE_PUSH_MODE=OFF)');
    return;
  }
  if (timer || startupTimer) return;
  // Staggered well behind the reservation sweeps so a boot does not fire every
  // connector at once against the same portal session.
  startupTimer = setTimeout(() => { runSweep().catch(() => null); }, startupDelaySeconds() * 1000);
  timer = setInterval(() => { runSweep().catch(() => null); }, intervalMinutes() * 60 * 1000);
  logger.info(`[economy-rate-push] scheduler started every ${intervalMinutes()} minute(s) in ${pushMode()} mode`);
}

export function stopEconomyRatePushScheduler() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}
