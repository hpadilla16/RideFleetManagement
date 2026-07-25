/**
 * Nightly cleanup for stuck CheckoutSession rows.
 *
 * Two operations every 24h at 07:00 UTC (= 03:00 AST in PR):
 *   1. Flag sessions stuck in a non-terminal step for > 4 hours by
 *      setting abandonedAt. The dashboard picks them up the next time
 *      it renders.
 *   2. Flag any preauth deposit hold > 24h old on abandoned sessions
 *      into the payment ops staff queue so the hold gets released.
 *      (2026-07-24: this step used to STAMP depositHoldVoidedAt without
 *      calling any gateway — it now records the outstanding work instead
 *      of falsely claiming the customer's money was released.)
 *
 * Read-only mode: set CHECKOUT_SESSION_CLEANUP_ENABLED=false to disable
 * the entire sweep (e.g. while debugging without auto-voiding state).
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { appendEvent } from './state-machine.js';
import { paymentOpsQueue } from '../payment-gateway/payment-ops-queue.service.js';

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
 * Flag stale preauth deposits (>24h) on abandoned sessions for staff action.
 *
 * ⚠️ 2026-07-24 (B5 Phase 1 — MONEY-ADJACENT FIX, QA B1). This function used
 * to stamp `depositHoldVoidedAt` WITHOUT calling any gateway ("Spin client
 * integration lands in Phase 2"). That made the database claim the customer's
 * hold was released while the hold stayed LIVE on their card for 7-30 days —
 * and it permanently hid the row from any future real sweep, because every
 * sweep skips `depositHoldVoidedAt != null`.
 *
 * The false stamp is REMOVED. `depositHoldVoidedAt` now means exactly one
 * thing: a gateway void actually succeeded. Until the B5 gateway arm exists,
 * this sweep raises a PaymentOpsFlag(STRANDED_DEPOSIT_HOLD, NOT_ATTEMPTED) so
 * staff can release the hold manually and the work is visible instead of
 * silently mislabeled.
 *
 * Strictly more truthful than before: no counter flow loses a capability (the
 * old stamp released nothing), and nothing new is voided automatically.
 *
 * TODO(B5-gateway): when the real void/refund arm lands, this sweep calls it
 * and only then stamps depositHoldVoidedAt, branching void↔refund on the
 * 5:30 PM EST batch close (design §6, Hector answer #6).
 */
async function voidStalePreauths() {
  const cutoff = new Date(Date.now() - PREAUTH_VOID_THRESHOLD_MS);
  const candidates = await prisma.checkoutSession.findMany({
    where: { abandonedAt: { not: null }, agreementId: { not: null } },
    select: {
      id: true, agreementId: true,
      agreement: {
        select: {
          id: true, tenantId: true, reservationId: true,
          depositHoldId: true, depositHoldVoidedAt: true,
          depositHoldAmount: true, depositHoldExpiresAt: true, cardOnFileCapturedAt: true,
        },
      },
    },
  });

  let flagged = 0;
  for (const s of candidates) {
    const ag = s.agreement;
    if (!ag?.depositHoldId) continue;
    if (ag.depositHoldVoidedAt) continue; // a REAL gateway void already happened
    if (ag.cardOnFileCapturedAt && ag.cardOnFileCapturedAt > cutoff) continue;
    if (!ag.tenantId) continue;
    try {
      // NO stamp — the hold is still live on the customer's card. Make the
      // outstanding work visible instead of pretending it is done.
      await paymentOpsQueue.raise({
        tenantId: ag.tenantId,
        kind: 'STRANDED_DEPOSIT_HOLD',
        status: 'NOT_ATTEMPTED',
        reservationId: ag.reservationId || null,
        rentalAgreementId: ag.id,
        gatewayRef: ag.depositHoldId,
        amount: ag.depositHoldAmount ?? null,
        note: 'Abandoned checkout >24h with a live deposit hold. Release it on the gateway, then mark resolved.',
      });
      logger.warn('[checkout-session] stale preauth flagged for staff (hold still LIVE)', {
        agreementId: ag.id, depositHoldId: ag.depositHoldId,
      });
      flagged += 1;
    } catch (err) {
      logger.warn('[checkout-session] stale preauth flag failed', {
        agreementId: ag.id, err: err.message,
      });
    }
  }
  return flagged;
}

async function runSweep() {
  if (sweepInProgress) {
    logger.info('[checkout-session] cleanup sweep skipped — already running');
    return;
  }
  sweepInProgress = true;
  try {
    const flagged = await flagStuckSessions();
    const strandedHoldsFlagged = await voidStalePreauths();
    logger.info('[checkout-session] cleanup sweep done', { flagged, strandedHoldsFlagged });
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
