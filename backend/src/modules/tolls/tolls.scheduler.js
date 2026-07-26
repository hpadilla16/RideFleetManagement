import { tollsService } from './tolls.service.js';

const DEFAULT_STARTUP_DELAY_SECONDS = 45;
let tollAutoSyncTimer = null;
let tollStartupTimer = null;
let tollSweepInProgress = false;

// SunPass runs on its OWN timer/flag, fully independent of AutoExpreso (Hector's rule:
// one connector can never depend on another). Its own enable flag, interval and
// in-progress guard mean a stuck/failed AutoExpreso sweep never blocks SunPass.
let sunpassSyncTimer = null;
let sunpassStartupTimer = null;
let sunpassSweepInProgress = false;

// Re-match sweep (TollBridge finding (b), 2026-07-26): retries unmatched tolls
// inside each sede's own window so month-late CA statements still land on the
// right (usually closed) contract. Own timer/flag per Hector's rule — one
// connector can never depend on another.
let rematchTimer = null;
let rematchStartupTimer = null;
let rematchInProgress = false;

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

function sunpassSyncEnabled() {
  return String(process.env.TOLLS_SUNPASS_AUTO_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
}

function sunpassSyncIntervalMs() {
  const minutes = Number(process.env.TOLLS_SUNPASS_SYNC_INTERVAL_MINUTES || 720);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 720) * 60 * 1000;
}

// Stagger SunPass off the AutoExpreso startup so they don't both fire at boot and queue
// on the shared browser semaphore.
function sunpassStartupDelayMs() {
  const seconds = Number(process.env.TOLLS_SUNPASS_STARTUP_DELAY_SECONDS || 90);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 90) * 1000;
}

function rematchEnabled() {
  return String(process.env.TOLLS_REMATCH_ENABLED || 'true').toLowerCase() !== 'false';
}

function rematchIntervalMs() {
  const minutes = Number(process.env.TOLLS_REMATCH_INTERVAL_MINUTES || 360);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 360) * 60 * 1000;
}

// Staggered well behind both scraper startups; the re-match reads the DB only
// (no browser), so the stagger is about boot noise, not the page semaphore.
function rematchStartupDelayMs() {
  const seconds = Number(process.env.TOLLS_REMATCH_STARTUP_DELAY_SECONDS || 180);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 180) * 1000;
}

async function runRematchSweep() {
  if (rematchInProgress) {
    console.log('[tolls] re-match sweep skipped because one is already running');
    return;
  }

  rematchInProgress = true;
  try {
    const result = await tollsService.runRematchSweep();
    console.log(`[tolls] re-match sweep processed ${result.processedTenants} tenant(s)`);
  } catch (error) {
    console.error('[tolls] re-match sweep failed', error);
  } finally {
    rematchInProgress = false;
  }
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

async function runSunPassSyncSweep() {
  if (sunpassSweepInProgress) {
    console.log('[tolls] SunPass sync sweep skipped because one is already running');
    return;
  }

  sunpassSweepInProgress = true;
  try {
    const result = await tollsService.runSunPassSyncSweep();
    console.log(`[tolls] SunPass sync sweep processed ${result.processedTenants} tenant(s)`);
  } catch (error) {
    console.error('[tolls] SunPass sync sweep failed', error);
  } finally {
    sunpassSweepInProgress = false;
  }
}

export function startTollAutoSyncScheduler() {
  // AutoExpreso (PR) timer
  if (!autoSyncEnabled()) {
    console.log('[tolls] auto sync scheduler disabled');
  } else if (!tollAutoSyncTimer && !tollStartupTimer) {
    tollStartupTimer = setTimeout(() => {
      runTollAutoSyncSweep().catch(() => null);
    }, startupDelayMs());

    tollAutoSyncTimer = setInterval(() => {
      runTollAutoSyncSweep().catch(() => null);
    }, autoSyncIntervalMs());

    console.log(`[tolls] auto sync scheduler started every ${Math.round(autoSyncIntervalMs() / 60000)} minute(s)`);
  }

  // SunPass (FL) timer — INDEPENDENT cadence + guard, never blocked by AutoExpreso.
  if (!sunpassSyncEnabled()) {
    console.log('[tolls] SunPass sync scheduler disabled');
  } else if (!sunpassSyncTimer && !sunpassStartupTimer) {
    sunpassStartupTimer = setTimeout(() => {
      runSunPassSyncSweep().catch(() => null);
    }, sunpassStartupDelayMs());

    sunpassSyncTimer = setInterval(() => {
      runSunPassSyncSweep().catch(() => null);
    }, sunpassSyncIntervalMs());

    console.log(`[tolls] SunPass sync scheduler started every ${Math.round(sunpassSyncIntervalMs() / 60000)} minute(s)`);
  }

  // Re-match timer — INDEPENDENT cadence + guard, DB-only work.
  if (!rematchEnabled()) {
    console.log('[tolls] re-match scheduler disabled');
  } else if (!rematchTimer && !rematchStartupTimer) {
    rematchStartupTimer = setTimeout(() => {
      runRematchSweep().catch(() => null);
    }, rematchStartupDelayMs());

    rematchTimer = setInterval(() => {
      runRematchSweep().catch(() => null);
    }, rematchIntervalMs());

    console.log(`[tolls] re-match scheduler started every ${Math.round(rematchIntervalMs() / 60000)} minute(s)`);
  }
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
  if (sunpassStartupTimer) {
    clearTimeout(sunpassStartupTimer);
    sunpassStartupTimer = null;
  }
  if (sunpassSyncTimer) {
    clearInterval(sunpassSyncTimer);
    sunpassSyncTimer = null;
  }
  if (rematchStartupTimer) {
    clearTimeout(rematchStartupTimer);
    rematchStartupTimer = null;
  }
  if (rematchTimer) {
    clearInterval(rematchTimer);
    rematchTimer = null;
  }
}
