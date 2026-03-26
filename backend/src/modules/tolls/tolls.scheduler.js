import { tollsService } from './tolls.service.js';

const DEFAULT_STARTUP_DELAY_SECONDS = 45;
let tollAutoSyncTimer = null;
let tollStartupTimer = null;
let tollSweepInProgress = false;

function autoSyncEnabled() {
  return String(process.env.TOLLS_AUTO_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
}

function autoSyncIntervalMs() {
  const minutes = Number(process.env.TOLLS_AUTO_SYNC_INTERVAL_MINUTES || 15);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000;
}

function startupDelayMs() {
  const seconds = Number(process.env.TOLLS_AUTO_SYNC_STARTUP_DELAY_SECONDS || DEFAULT_STARTUP_DELAY_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_STARTUP_DELAY_SECONDS) * 1000;
}

async function runTollAutoSyncSweep() {
  if (tollSweepInProgress) {
    console.log('[tolls] auto sync sweep skipped because one is already running');
    return;
  }

  tollSweepInProgress = true;
  try {
    const result = await tollsService.runAutomaticSyncSweep();
    console.log(`[tolls] auto sync sweep processed ${result.processedTenants} tenant(s)`);
  } catch (error) {
    console.error('[tolls] auto sync sweep failed', error);
  } finally {
    tollSweepInProgress = false;
  }
}

export function startTollAutoSyncScheduler() {
  if (!autoSyncEnabled()) {
    console.log('[tolls] auto sync scheduler disabled');
    return;
  }
  if (tollAutoSyncTimer || tollStartupTimer) return;

  tollStartupTimer = setTimeout(() => {
    runTollAutoSyncSweep().catch(() => null);
  }, startupDelayMs());

  tollAutoSyncTimer = setInterval(() => {
    runTollAutoSyncSweep().catch(() => null);
  }, autoSyncIntervalMs());

  console.log(`[tolls] auto sync scheduler started every ${Math.round(autoSyncIntervalMs() / 60000)} minute(s)`);
}

export function stopTollAutoSyncScheduler() {
  if (tollStartupTimer) {
    clearTimeout(tollStartupTimer);
    tollStartupTimer = null;
  }
  if (tollAutoSyncTimer) {
    clearInterval(tollAutoSyncTimer);
    tollAutoSyncTimer = null;
  }
}
