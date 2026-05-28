/**
 * Nightly cleanup for stuck CheckoutSession rows.
 *
 * Two operations every 24h at 07:00 UTC (= 03:00 AST in PR):
 *   1. Flag sessions stuck in a non-terminal step for > 4 hours by
 *      setting abandonedAt. The dashboard picks them up the next time
 *      it renders.
 *   2. Auto-void any preauth deposit hold > 24h old on abandoned
 *      sessions. Prevents customer money from sitting in hold limbo
 *      while ops figures out what happened.
 *
 * Read-only mode: set CHECKOUT_SESSION_CLEANUP_ENABLED=false to disable
 * the entire sweep (e.g. while debugging without auto-voiding state).
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { appendEvent } from './state-machine.js';

const SWEEP_HOUR_UTC = 7;             // 07:00 UTC = 03:00 AST
const STALL_THRESHOLD_MS = 4 * 60 * 60 * 1000;       // 4 hours
const PREAUTH_VOID_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

let sweepTimer = null;
let sweepInProgress = false;

function enabled() {
  return String(process.env.CHECKOUT_SESSION_CLEANUP_ENABLED || 'true').toLowerCase() !== 'false';
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SWEEP_HOUR_UTC, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Flag sessions stuck > 4h in a non-terminal step. Sets abandonedAt +
 * a STALLED event in the events log. Does NOT advance currentStep
 * (that would be lying about state). Returns the count flagged.
 */
async function flagStuckSessions() {
  const cutoff = new Date(Date.now() - STALL_THRESHOLD_MS);
  const stalled = await prisma.checkoutSession.findMany({
    where: {
      abandonedAt: null,
      currentStep: { notIn: ['CLOSED', 'CANCELLED'] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, events: true, currentStep: true, updatedAt: true },
  });
  if (stalled.length === 0) return 0;

  for (const s of stalled) {
    try {
      await prisma.checkoutSession.update({
        where: { id: s.id },
        data: {
          abandonedAt: new Date(),
          abandonedReason: `auto_flagged_stalled_at_${s.currentStep.toLowerCase()}`,
          events: appendEvent(s.events, {
            kind: 'AUTO_FLAGGED_STALLED',
            stalledStep: s.currentStep,
            stalledSinceUpdatedAt: s.updatedAt.toISOString(),
          }),
        },
      });
    } catch (err) {
      logger.warn('[checkout-session] failed to flag stalled session', {
        sessionId: s.id, err: err.message,
      });
    }
  }
  return stalled.length;
}

/**
 * Void preauth deposits older than 24h on abandoned sessions. Spin
 * holds typically expire on their own at ~7 days, but actively voiding
 * here releases the customer's funds sooner. Spin client integration
 * lands in Phase 2 — for now we just mark depositHoldVoidedAt so the
 * UI stops showing the hold and a Phase 2 follow-up runs the actual
 * Spin /void call.
 */
async function voidStalePreauths() {
  const cutoff = new Date(Date.now() - PREAUTH_VOID_THRESHOLD_MS);
  const candidates = await prisma.checkoutSession.findMany({
    where: { abandonedAt: { not: null }, agreementId: { not: null } },
    select: {
      id: true, agreementId: true,
      agreement: {
        select: {
          id: true, depositHoldId: true, depositHoldVoidedAt: true,
          depositHoldExpiresAt: true, cardOnFileCapturedAt: true,
        },
      },
    },
  });

  let voided = 0;
  for (const s of candidates) {
    const ag = s.agreement;
    if (!ag?.depositHoldId) continue;
    if (ag.depositHoldVoidedAt) continue;
    if (ag.cardOnFileCapturedAt && ag.cardOnFileCapturedAt > cutoff) continue;
    try {
      await prisma.rentalAgreement.update({
        where: { id: ag.id },
        data: { depositHoldVoidedAt: new Date() },
      });
      logger.info('[checkout-session] marked preauth for void', {
        agreementId: ag.id, depositHoldId: ag.depositHoldId,
      });
      voided += 1;
    } catch (err) {
      logger.warn('[checkout-session] preauth void mark failed', {
        agreementId: ag.id, err: err.message,
      });
    }
  }
  return voided;
}

async function runSweep() {
  if (sweepInProgress) {
    logger.info('[checkout-session] cleanup sweep skipped — already running');
    return;
  }
  sweepInProgress = true;
  try {
    const flagged = await flagStuckSessions();
    const voided = await voidStalePreauths();
    logger.info('[checkout-session] cleanup sweep done', { flagged, preauthsMarkedForVoid: voided });
  } catch (err) {
    logger.error('[checkout-session] cleanup sweep failed', { err: err.message });
  } finally {
    sweepInProgress = false;
    sweepTimer = setTimeout(() => runSweep().catch(() => null), msUntilNextRun());
  }
}

export function startCheckoutSessionCleanupScheduler() {
  if (!enabled()) {
    logger.info('[checkout-session] cleanup scheduler disabled');
    return;
  }
  if (sweepTimer) return;
  const delay = msUntilNextRun();
  const hoursUntil = Math.round(delay / (60 * 60 * 1000));
  sweepTimer = setTimeout(() => runSweep().catch(() => null), delay);
  logger.info(`[checkout-session] cleanup scheduler started — next run in ~${hoursUntil}h (daily at ${SWEEP_HOUR_UTC}:00 UTC)`);
}

export function stopCheckoutSessionCleanupScheduler() {
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
}

// Exported for tests / manual triggering.
export const _internal = { runSweep, flagStuckSessions, voidStalePreauths };
