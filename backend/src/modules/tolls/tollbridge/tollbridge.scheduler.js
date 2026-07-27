/**
 * TollBridge poller timer (2026-07-27). Own interval + in-progress guard,
 * independent of the scraper sweeps (Hector's rule: one connector never
 * blocks another). DORMANT: TOLLBRIDGE_IMPORT_ENABLED defaults false, so
 * startTollBridgeImportScheduler is a no-op until activated.
 */
import logger from '../../../lib/logger.js';
import {
  TOLLBRIDGE_IMPORT_ENABLED, TOLLBRIDGE_INTERVAL_MINUTES, TOLLBRIDGE_STARTUP_DELAY_SECONDS
} from './tollbridge.constants.js';

let timer = null;
let startupTimer = null;
let inProgress = false;

async function runSweep() {
  if (inProgress) { logger.info('[tollbridge] poll skipped — one already running'); return; }
  inProgress = true;
  try {
    const { pollAllTenants } = await import('./tollbridge-import.service.js');
    const out = await pollAllTenants();
    logger.info(`[tollbridge] poll sweep processed ${out.processedTenants} tenant(s)`);
  } catch (err) {
    logger.error('[tollbridge] poll sweep failed', { err: String(err?.message || err) });
  } finally {
    inProgress = false;
  }
}

export function startTollBridgeImportScheduler() {
  if (!TOLLBRIDGE_IMPORT_ENABLED) {
    logger.info('[tollbridge] import scheduler disabled (TOLLBRIDGE_IMPORT_ENABLED != true)');
    return;
  }
  if (timer || startupTimer) return;
  startupTimer = setTimeout(() => { runSweep().catch(() => null); }, TOLLBRIDGE_STARTUP_DELAY_SECONDS * 1000);
  timer = setInterval(() => { runSweep().catch(() => null); }, TOLLBRIDGE_INTERVAL_MINUTES * 60 * 1000);
  logger.info(`[tollbridge] import scheduler started every ${TOLLBRIDGE_INTERVAL_MINUTES} minute(s)`);
}

export function stopTollBridgeImportScheduler() {
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}
