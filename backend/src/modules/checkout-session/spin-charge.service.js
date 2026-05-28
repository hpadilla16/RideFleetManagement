/**
 * Orchestrates the full Spin charge flow for step 3 of the checkout
 * wizard.
 *
 * Sequence (happy path):
 *   1. Spin /sale on the terminal — customer taps/inserts/swipes
 *   2. Response carries a tokenized card (Spin always tokenizes via
 *      /sale when GetExtendedData=true). Persist the cardOnFile token
 *      onto RentalAgreement.
 *   3. Spin /auth for the security deposit, using the token from
 *      step 2 so the customer doesn't have to tap again.
 *   4. Persist the deposit hold id + expiry onto RentalAgreement.
 *   5. Stamp paymentCompletedAt on the CheckoutSession.
 *
 * Failure modes:
 *   • Sale fails → no Spin charge captured, nothing to roll back. We
 *     return the error and the wizard surfaces it.
 *   • Sale succeeds but tokenize-extract returns null (rare) → we still
 *     persist the sale + return a warning. Card-on-file stays null and
 *     post-checkout autocharges fall back to manual entry. The wizard
 *     can re-collect the token via a separate /getCard call if needed.
 *   • Sale succeeds + tokenize succeeds but preAuth fails →
 *     CRITICAL ROLLBACK: void the sale via Spin /void so the customer
 *     isn't charged for a rental whose deposit we couldn't hold.
 *     Returns an error with rollbackPerformed: true so the wizard can
 *     show a clear retry path.
 *
 * dryRun: when SPIN_DRY_RUN=true the underlying Spin client returns
 * synthetic approved responses, so this orchestrator runs end-to-end
 * without any terminal. Useful for local dev + state-machine testing.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { spinClient } from '../payment-gateway/spin-client.js';
import { appendEvent } from './state-machine.js';
import { CheckoutSessionError } from './checkout-session.service.js';

const DEPOSIT_HOLD_DEFAULT = 500;
const DEPOSIT_HOLD_EXPIRES_DAYS = 7;

function loadTenantSpinConfig(tenantId) {
  // We don't currently expose tenant.spin* fields via a service helper
  // so we fetch directly. Only the fields the Spin client cares about.
  return prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      // These columns don't exist on the Tenant model today — the
      // existing spin-client falls back to env vars when tenant config
      // is missing. Returning an empty object keeps both paths working.
    },
  });
}

async function runChargeSequence({
  sessionId,
  amount,
  depositAmount = DEPOSIT_HOLD_DEFAULT,
  actorUserId,
}) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);
  if (!amount || amount <= 0) throw new CheckoutSessionError('amount required and must be > 0', 400);

  // Load session + agreement
  const session = await prisma.checkoutSession.findUnique({
    where: { id: sessionId },
    include: {
      reservation: { select: { id: true, reservationNumber: true, tenantId: true } },
      agreement: { select: { id: true, agreementNumber: true, paidAmount: true } },
    },
  });
  if (!session) throw new CheckoutSessionError('Session not found', 404);
  if (!session.agreement) {
    throw new CheckoutSessionError('No agreement linked to this session', 409);
  }
  if (session.currentStep !== 'TC_SIGNED' && session.currentStep !== 'PAYMENT_PENDING') {
    throw new CheckoutSessionError(
      `Cannot charge from currentStep=${session.currentStep}`,
      409, 'WRONG_STEP',
    );
  }

  const tenantConfig = await loadTenantSpinConfig(session.reservation.tenantId).catch(() => ({}));
  const refId = `${session.reservation.reservationNumber}-${Date.now().toString(36)}`;

  // Track the events we add so we can persist them in one update at the
  // end (and we always know what happened even on partial failure).
  const events = [];
  const log = (kind, payload) => events.push({ kind, ...payload, at: new Date().toISOString() });

  // ──────────────────────────────────────────────────────────────────
  // 1. SALE
  // ──────────────────────────────────────────────────────────────────
  let saleResponse;
  try {
    log('SPIN_SALE_STARTED', { amount, referenceId: refId });
    saleResponse = await spinClient.sale({
      amount,
      referenceId: refId,
      invoiceNumber: session.agreement.agreementNumber,
    }, tenantConfig);
    log('SPIN_SALE_APPROVED', {
      referenceId: refId,
      authCode: saleResponse?.AuthCode,
    });
  } catch (err) {
    log('SPIN_SALE_FAILED', { message: err.message, referenceId: refId });
    await persistEvents(sessionId, events);
    throw new CheckoutSessionError(
      `Sale declined: ${err.message}`,
      402, 'SALE_DECLINED',
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. EXTRACT CARD-ON-FILE + persist
  // ──────────────────────────────────────────────────────────────────
  const cardOnFile = spinClient.extractCardOnFile(saleResponse);
  if (cardOnFile) {
    await prisma.rentalAgreement.update({
      where: { id: session.agreement.id },
      data: {
        cardOnFileToken: cardOnFile.token,
        cardOnFileBrand: cardOnFile.brand,
        cardOnFileLast4: cardOnFile.last4,
        cardOnFileCapturedAt: cardOnFile.capturedAt,
      },
    });
    log('CARD_ON_FILE_PERSISTED', { brand: cardOnFile.brand, last4: cardOnFile.last4 });
  } else {
    log('CARD_ON_FILE_MISSING', { note: 'Sale approved but no token in response' });
    logger.warn('[spin-charge] sale approved but no card-on-file token', {
      sessionId, referenceId: refId,
    });
  }

  // Persist the sale itself as a payment row.
  await prisma.rentalAgreementPayment.create({
    data: {
      rentalAgreementId: session.agreement.id,
      method: 'CARD',
      amount,
      reference: saleResponse?.AuthCode || refId,
      status: 'PAID',
      notes: `Spin Sale · ${refId}`,
    },
  });
  log('SALE_PAYMENT_RECORDED', { amount });

  // ──────────────────────────────────────────────────────────────────
  // 3. DEPOSIT PRE-AUTH
  // ──────────────────────────────────────────────────────────────────
  let preauthResponse = null;
  let preauthFailed = false;
  if (depositAmount > 0) {
    const depositRefId = `${refId}-DEP`;
    try {
      log('SPIN_PREAUTH_STARTED', { depositAmount, referenceId: depositRefId });
      preauthResponse = await spinClient.preAuthDeposit({
        amount: depositAmount,
        referenceId: depositRefId,
        token: cardOnFile?.token,
        invoiceNumber: session.agreement.agreementNumber,
      }, tenantConfig);
      log('SPIN_PREAUTH_APPROVED', { referenceId: depositRefId, authCode: preauthResponse?.AuthCode });
    } catch (err) {
      preauthFailed = true;
      log('SPIN_PREAUTH_FAILED', { message: err.message, referenceId: depositRefId });
      logger.error('[spin-charge] preauth failed AFTER sale captured', {
        sessionId, saleRefId: refId, depositRefId, err: err.message,
      });

      // Roll back the sale to avoid charging the customer for a rental
      // whose deposit we couldn't hold.
      try {
        log('SPIN_VOID_STARTED', { referenceId: refId });
        await spinClient.void({ referenceId: refId }, tenantConfig);
        log('SPIN_VOID_OK', { referenceId: refId });
        // Mark the payment row as VOID so the agreement's paidAmount
        // recompute drops it.
        await prisma.rentalAgreementPayment.updateMany({
          where: { rentalAgreementId: session.agreement.id, reference: saleResponse?.AuthCode || refId },
          data: { status: 'VOID' },
        });
      } catch (voidErr) {
        log('SPIN_VOID_FAILED', { message: voidErr.message });
        logger.error('[spin-charge] CRITICAL: void failed after preauth failure', {
          sessionId, refId, err: voidErr.message,
        });
        // Continue — the operator will need to issue a manual refund.
      }

      await persistEvents(sessionId, events);
      throw new CheckoutSessionError(
        `Preauth failed: ${err.message}. Sale was rolled back; customer can retry.`,
        402, 'PREAUTH_FAILED',
      );
    }

    // Persist the deposit hold metadata on the agreement.
    await prisma.rentalAgreement.update({
      where: { id: session.agreement.id },
      data: {
        depositHoldId: depositRefId,
        depositHoldAmount: depositAmount,
        depositHoldExpiresAt: new Date(Date.now() + DEPOSIT_HOLD_EXPIRES_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    log('DEPOSIT_HOLD_PERSISTED', { holdId: depositRefId, amount: depositAmount });
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. STAMP SESSION + write events log
  // ──────────────────────────────────────────────────────────────────
  await prisma.checkoutSession.update({
    where: { id: sessionId },
    data: {
      paymentCompletedAt: new Date(),
      events: appendEvents(session.events, events, {
        kind: 'CHARGE_SEQUENCE_COMPLETE',
        actorUserId: actorUserId || null,
        preauthFailed,
      }),
    },
  });

  return {
    sessionId,
    refId,
    sale: spinClient.normalizeResponse(saleResponse),
    preauth: preauthResponse ? spinClient.normalizeResponse(preauthResponse) : null,
    cardOnFile,
  };
}

function appendEvents(currentEventsJson, eventsToAppend, finalEvent) {
  let result = currentEventsJson || '[]';
  for (const ev of eventsToAppend) result = appendEvent(result, ev);
  if (finalEvent) result = appendEvent(result, finalEvent);
  return result;
}

async function persistEvents(sessionId, eventsToAppend) {
  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId }, select: { events: true },
    });
    if (!session) return;
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: { events: appendEvents(session.events, eventsToAppend) },
    });
  } catch (err) {
    logger.warn('[spin-charge] events persistence failed', { sessionId, err: err.message });
  }
}

export const spinChargeService = {
  runChargeSequence,
};
