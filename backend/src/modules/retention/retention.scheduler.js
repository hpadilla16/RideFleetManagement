/**
 * retention.scheduler.js — daily driver for the GDPR Wave 2 Phase C retention
 * sweep. Structure copied from checkout-session.scheduler.js.
 *
 * SACRED INVARIANTS live at THIS edge:
 *   1. OFF BY DEFAULT — enabled() is RETENTION_SWEEP_ENABLED and defaults to
 *      false; when off, start* logs and DOES NOT register a timer, so the
 *      sweep never runs.
 *   2. PREVIEW-ONLY BY DEFAULT — applyEnabled() is RETENTION_SWEEP_APPLY,
 *      default false. Even when the scheduler runs, a false flag means
 *      runSweep({ apply:false }) — it LOGS what it would purge and mutates
 *      NOTHING. Only RETENTION_SWEEP_APPLY=true passes apply:true.
 *   5. KILL-SWITCH — both flags are re-read on every tick, so flipping
 *      RETENTION_SWEEP_ENABLED=false halts everything on the next tick
 *      (and stop* clears the timer immediately).
 *
 * Runs daily at 08:30 UTC — deliberately staggered off the handoff-reminder and
 * checkout-session cleanup schedulers (which fire at listen / 07:00 UTC) so the
 * data-destroying sweep never overlaps the money-adjacent sweeps.
 */

import logger from '../../lib/logger.js';
import { runSweep } from './retention.service.js';

const SWEEP_HOUR_UTC = 8;    // 08:30 UTC = 04:30 AST — staggered off 07:00 checkout sweep
const SWEEP_MINUTE_UTC = 30;

let sweepTimer = null;
let sweepInProgress = false;

export function enabled() {
  return String(process.env.RETENTION_SWEEP_ENABLED || '').toLowerCase() === 'true';
}

export function applyEnabled() {
  return String(process.env.RETENTION_SWEEP_APPLY || '').toLowerCase() === 'true';
}

export function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    SWEEP_HOUR_UTC, SWEEP_MINUTE_UTC, 0, 0,
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function tick() {
  // KILL-SWITCH — re-read the flag every tick. A disabled scheduler that was
  // already armed stops re-arming here and the sweep does not run.
  if (!enabled()) {
    logger.info('[retention] sweep skipped — RETENTION_SWEEP_ENABLED is off');
    sweepTimer = null;
    return;
  }
  if (sweepInProgress) {
    logger.info('[retention] sweep skipped — already running');
    return;
  }
  sweepInProgress = true;
  try {
    const apply = applyEnabled();
    logger.info(`[retention] sweep starting (${apply ? 'APPLY' : 'PREVIEW'})`);
    await runSweep({ apply });
  } catch (err) {
    logger.error('[retention] sweep failed', { err: err?.message || String(err) });
  } finally {
    sweepInProgress = false;
    // Re-arm only while still enabled (kill-switch honoured between runs too).
    if (enabled()) {
      sweepTimer = setTimeout(() => tick().catch(() => null), msUntilNextRun());
    } else {
      sweepTimer = null;
    }
  }
}

export function startRetentionSweepScheduler() {
  // OFF BY DEFAULT — do not register while the flag is off.
  if (!enabled()) {
    logger.info('[retention] sweep scheduler disabled (RETENTION_SWEEP_ENABLED off)');
    return;
  }
  if (sweepTimer) return;
  const delay = msUntilNextRun();
  const hoursUntil = Math.round(delay / (60 * 60 * 1000));
  sweepTimer = setTimeout(() => tick().catch(() => null), delay);
  logger.info(
    `[retention] sweep scheduler started — ${applyEnabled() ? 'APPLY' : 'PREVIEW'} mode, next run in ~${hoursUntil}h (daily at ${SWEEP_HOUR_UTC}:${String(SWEEP_MINUTE_UTC).padStart(2, '0')} UTC)`,
  );
}

export function stopRetentionSweepScheduler() {
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
}

// Exported for tests / manual triggering.
export const _internal = { tick, msUntilNextRun };
