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
import { iposTransactClient } from '../payment-gateway/ipos-transact-client.js';
import { appendEvent } from './state-machine.js';
import { CheckoutSessionError } from './checkout-session.service.js';

// DEPOSIT_HOLD_DEFAULT removed 2026-05-29. The deposit hold amount
// now ALWAYS comes from the reservation (securityDepositAmount column
// or SECURITY_DEPOSIT charges sum). If the reservation doesn't specify
// one, we hold $0 (no hold) — never a generic $500 charge.
const DEPOSIT_HOLD_EXPIRES_DAYS = 7;

/**
 * Mirror a Spin-orchestrated payment into the ReservationPayment ledger
 * so it appears in the View Payments list alongside OTC entries.
 *
 * The wizard's primary write target is RentalAgreementPayment (the
 * agreement-level ledger that feeds the PDF + balance math). But the
 * reservation View Payments page reads ReservationPayment. So when a
 * sale / deposit hold completes we synthesize a matching row here and
 * link them via rentalAgreementPaymentId so they don't appear twice
 * in agreement balance recomputes.
 *
 * Best-effort: a failure here is logged but never throws. The agreement
 * ledger (which is the source of truth for the wizard) stays intact.
 */
async function mirrorToReservationPayment({
  reservationId,
  agreementPaymentId = null,
  method,
  amount,
  reference,
  notes,
  paidAt = new Date(),
}) {
  if (!reservationId) return null;
  try {
    return await prisma.reservationPayment.create({
      data: {
        reservationId,
        method: String(method || 'OTHER').toUpperCase(),
        amount: Number(amount || 0),
        reference: reference || null,
        status: 'PAID',
        paidAt,
        origin: 'OTC',
        gateway: 'SPIN',
        notes: notes || null,
        ...(agreementPaymentId ? { rentalAgreementPaymentId: agreementPaymentId } : {}),
      },
    });
  } catch (err) {
    logger.warn('[spin-charge] reservationPayment mirror failed', {
      reservationId, agreementPaymentId, err: String(err?.message || err),
    });
    return null;
  }
}

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
  depositAmount: depositAmountHint,
  actorUserId,
}) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);

  // 2026-05-28 — Phase 2.x amendment.
  //
  // Pre-paid customers (OTA voucher, customer portal pre-charge, etc.)
  // arrive at checkout with $0 balance owed. They STILL need:
  //   • a card-on-file tokenized for post-rental autocharges (tolls,
  //     overage fuel, damage),
  //   • a security deposit pre-auth held against the same card.
  //
  // We model this as a "deposit-only" branch: skip /sale, run /getCard
  // to tokenize, then run /Auth for the deposit hold. The wizard
  // surfaces "Pre-paid · saving card + deposit hold" in this branch.
  //
  // Negative / NaN amounts are still rejected — those are bugs, not
  // legitimate pre-paid scenarios.
  const requestedAmount = Number(amount);
  if (!Number.isFinite(requestedAmount) || requestedAmount < 0) {
    throw new CheckoutSessionError('amount must be a non-negative number', 400);
  }
  const isPrepaid = requestedAmount === 0;

  // Load session + agreement
  const session = await prisma.checkoutSession.findUnique({
    where: { id: sessionId },
    include: {
      reservation: { select: { id: true, reservationNumber: true, tenantId: true } },
      agreement: {
        select: {
          id: true, agreementNumber: true, paidAmount: true, securityDepositAmount: true,
          // 2026-05-28 — Deposit can live as a SECURITY_DEPOSIT charge row
          // OR on the securityDepositAmount column. We sum the charges as
          // a fallback when the column is null/zero.
          charges: {
            where: { source: 'SECURITY_DEPOSIT', selected: true },
            select: { total: true },
          },
        },
      },
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

  // 2026-05-28 — Resolve the deposit hold from the AGREEMENT, not the
  // client request. The wizard sends an advisory hint (so its UI can
  // preview the hold amount) but the agreement is the source of truth.
  //
  // Lookup order:
  //   1. agreement.securityDepositAmount column (normalized)
  //   2. SUM of agreement.charges where source = SECURITY_DEPOSIT (legacy
  //      shape — most agreements live here)
  //   3. wizard hint
  //   4. default ($500)
  //
  // A zero/negative resolved amount → no hold (preauth skipped).
  const agreementDepositCol = Number(session.agreement.securityDepositAmount);
  const agreementDepositChargesSum = (session.agreement.charges || [])
    .reduce((sum, c) => sum + Number(c.total || 0), 0);
  const hintDeposit = Number(depositAmountHint);
  let depositAmount;
  if (Number.isFinite(agreementDepositCol) && agreementDepositCol > 0) {
    depositAmount = agreementDepositCol;
  } else if (Number.isFinite(agreementDepositChargesSum) && agreementDepositChargesSum > 0) {
    depositAmount = agreementDepositChargesSum;
  } else if (Number.isFinite(hintDeposit) && hintDeposit > 0) {
    depositAmount = hintDeposit;
  } else {
    // No deposit configured on the reservation → no hold. Used to
    // fall back to $500 here; that silently charged customers whose
    // rate plans didn't price in a deposit (comped rentals, certain
    // vehicle classes). Dropped 2026-05-29.
    depositAmount = 0;
  }
  logger.info('[spin-charge] resolved deposit amount', {
    sessionId, agreementDepositCol, agreementDepositChargesSum, hintDeposit, depositAmount,
  });

  const tenantConfig = await loadTenantSpinConfig(session.reservation.tenantId).catch(() => ({}));
  const refId = `${session.reservation.reservationNumber}-${Date.now().toString(36)}`;

  // Track the events we add so we can persist them in one update at the
  // end (and we always know what happened even on partial failure).
  const events = [];
  const log = (kind, payload) => events.push({ kind, ...payload, at: new Date().toISOString() });

  // ──────────────────────────────────────────────────────────────────
  // 1. SALE — skipped for the pre-paid branch
  // ──────────────────────────────────────────────────────────────────
  let saleResponse = null;
  let cardOnFile = null;

  if (isPrepaid) {
    log('SPIN_PREPAID_BRANCH', { reason: 'balance already $0 — capturing card + deposit only' });
    try {
      log('SPIN_GETCARD_STARTED', { referenceId: refId });
      const tokenResponse = await spinClient.getCard({ referenceId: refId }, tenantConfig);
      cardOnFile = spinClient.extractCardOnFile(tokenResponse);
      if (!cardOnFile) {
        // GetCard returned a 200 but no usable token. Without a token
        // the deposit hold can't be billed back later either, so treat
        // this as a hard fail. Operator can retry.
        throw new Error('Card capture succeeded but no token was returned');
      }
      log('SPIN_GETCARD_APPROVED', { brand: cardOnFile.brand, last4: cardOnFile.last4 });
    } catch (err) {
      log('SPIN_GETCARD_FAILED', { message: err.message, referenceId: refId });
      await persistEvents(sessionId, events);
      throw new CheckoutSessionError(
        `Card capture declined: ${err.message}`,
        402, 'CARD_CAPTURE_DECLINED',
      );
    }
  } else {
    try {
      log('SPIN_SALE_STARTED', { amount: requestedAmount, referenceId: refId });
      saleResponse = await spinClient.sale({
        amount: requestedAmount,
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
    cardOnFile = spinClient.extractCardOnFile(saleResponse);
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. PERSIST CARD-ON-FILE (sourced from /sale OR /getCard)
  // ──────────────────────────────────────────────────────────────────
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
  } else if (!isPrepaid) {
    log('CARD_ON_FILE_MISSING', { note: 'Sale approved but no token in response' });
    logger.warn('[spin-charge] sale approved but no card-on-file token', {
      sessionId, referenceId: refId,
    });
  }

  // Persist the sale itself as a payment row — only for the paying branch.
  if (!isPrepaid) {
    const saleReference = saleResponse?.AuthCode || refId;
    const saleNotes = `Spin Sale · ${refId}`;
    const agreementPayment = await prisma.rentalAgreementPayment.create({
      data: {
        rentalAgreementId: session.agreement.id,
        method: 'CARD',
        amount: requestedAmount,
        reference: saleReference,
        status: 'PAID',
        notes: saleNotes,
      },
    });
    // Mirror into ReservationPayment so View Payments sees it. Linked
    // via rentalAgreementPaymentId so the balance recompute logic
    // doesn't double-count.
    await mirrorToReservationPayment({
      reservationId: session.reservation.id,
      agreementPaymentId: agreementPayment.id,
      method: 'CARD',
      amount: requestedAmount,
      reference: saleReference,
      notes: saleNotes,
    });
    log('SALE_PAYMENT_RECORDED', { amount: requestedAmount });
  }

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
      logger.error('[spin-charge] preauth failed', {
        sessionId, saleRefId: refId, depositRefId, isPrepaid, err: err.message,
      });

      // Roll back the sale to avoid charging the customer for a rental
      // whose deposit we couldn't hold. The pre-paid branch has no sale
      // to void — the customer already paid through OTA / portal — so
      // we just surface the failure and let staff retry.
      if (!isPrepaid) {
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
      }

      await persistEvents(sessionId, events);
      throw new CheckoutSessionError(
        isPrepaid
          ? `Deposit hold declined: ${err.message}. Customer can retry; no sale was charged.`
          : `Preauth failed: ${err.message}. Sale was rolled back; customer can retry.`,
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
    // Mirror an AUTH_HOLD row into ReservationPayment so the View
    // Payments page reflects the active hold. amount is the hold value
    // (the existing pricing helper treats AUTH_HOLD as paidAmount math
    // for balance, so it lines up with the agreement totals).
    await mirrorToReservationPayment({
      reservationId: session.reservation.id,
      method: 'AUTH_HOLD',
      amount: depositAmount,
      reference: `SPIN_HOLD:${preauthResponse?.AuthCode || depositRefId}`,
      notes: `Spin deposit hold · ${depositRefId}`,
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

// =====================================================================
// 2026-05-29 — Two-tap payment flow (post-Hector beta-test feedback).
//
// The original runChargeSequence above runs sale → preauth in a single
// orchestrated burst. In production we found that the second physical
// card tap on the Dejavoo terminal cancelled too often, the rollback
// became unwieldy, and operators struggled to debug "which step
// declined". The split below replaces it with two operator-triggered
// transactions:
//
//   runSale         — Step 3a: charge the rental, capture card-on-file
//   runDepositHold  — Step 3b: hold the security deposit (fresh tap)
//
// Each method is independently retryable. A failed deposit hold does
// NOT void the sale — the sale is real money the customer owes for
// the rental and stays put. The operator can re-try the hold from the
// View Payments page later.
//
// The wizard renders these as two buttons; the second only appears
// after the first succeeds. Pre-paid customers (balance=$0) skip
// runSale entirely — Step 3 jumps straight to "Hold deposit" which
// also opportunistically captures card-on-file via GetExtendedData.
// =====================================================================

async function loadSessionAndAgreement(sessionId, allowedSteps) {
  const session = await prisma.checkoutSession.findUnique({
    where: { id: sessionId },
    include: {
      reservation: { select: { id: true, reservationNumber: true, tenantId: true } },
      agreement: {
        select: {
          id: true, agreementNumber: true, paidAmount: true, securityDepositAmount: true,
          cardOnFileToken: true, cardOnFileBrand: true, cardOnFileLast4: true,
          depositHoldId: true, depositHoldAmount: true,
          charges: {
            where: { source: 'SECURITY_DEPOSIT', selected: true },
            select: { total: true },
          },
        },
      },
    },
  });
  if (!session) throw new CheckoutSessionError('Session not found', 404);
  if (!session.agreement) {
    throw new CheckoutSessionError('No agreement linked to this session', 409);
  }
  if (allowedSteps && !allowedSteps.includes(session.currentStep)) {
    throw new CheckoutSessionError(
      `Cannot run from currentStep=${session.currentStep} (need one of: ${allowedSteps.join(', ')})`,
      409, 'WRONG_STEP',
    );
  }
  return session;
}

// Deposit amount resolution — order of precedence:
//   1. agreement.securityDepositAmount column (synced from the
//      reservation's pricing snapshot at agreement creation).
//   2. Sum of SECURITY_DEPOSIT-source charges on the agreement
//      (the line-item view of the same number, used as a fallback
//      when the column is null for legacy agreements).
//   3. Caller hint (e.g. the wizard's Step 3 prop) — only used when
//      neither of the above is set.
//
// 2026-05-29 — DROPPED the silent $500 fallback. If the agreement
// doesn't actually require a deposit (set on the reservation +
// inherited by the agreement), the caller gets 0 back and the wizard
// short-circuits to "no hold needed" rather than slapping a generic
// $500 hold on the customer's card.
function resolveDepositAmount(agreement, hint) {
  const col = Number(agreement.securityDepositAmount);
  const chargesSum = (agreement.charges || [])
    .reduce((sum, c) => sum + Number(c.total || 0), 0);
  const hintNum = Number(hint);
  if (Number.isFinite(col) && col > 0) return col;
  if (Number.isFinite(chargesSum) && chargesSum > 0) return chargesSum;
  if (Number.isFinite(hintNum) && hintNum > 0) return hintNum;
  return 0;
}

/**
 * Step 3a — Run the rental sale on the Dejavoo terminal. Returns the
 * approved sale + the card-on-file token captured from the response.
 *
 * The wizard calls this first. On success the agent sees a green
 * "Sale ✓" then a "Hold deposit" button appears, which calls
 * runDepositHold separately.
 *
 * Does NOT stamp paymentCompletedAt — that happens after the deposit
 * hold (or explicitly if the agent skips the deposit via a $0 hold).
 */
async function runSale({ sessionId, amount, actorUserId }) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);
  const requestedAmount = Number(amount);
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    throw new CheckoutSessionError(
      'amount must be a positive number (use runDepositHold directly for pre-paid customers)',
      400,
    );
  }

  const session = await loadSessionAndAgreement(sessionId, ['TC_SIGNED', 'PAYMENT_PENDING']);
  const tenantConfig = await loadTenantSpinConfig(session.reservation.tenantId).catch(() => ({}));
  const refId = `${session.reservation.reservationNumber}-SALE-${Date.now().toString(36)}`;

  const events = [];
  const log = (kind, payload) => events.push({ kind, ...payload, at: new Date().toISOString() });

  // ── 1. SALE on terminal (fresh tap) ────────────────────────────────
  let saleResponse;
  try {
    log('SPIN_SALE_STARTED', { amount: requestedAmount, referenceId: refId });
    saleResponse = await spinClient.sale({
      amount: requestedAmount,
      referenceId: refId,
      invoiceNumber: session.agreement.agreementNumber,
    }, tenantConfig);
    log('SPIN_SALE_APPROVED', { referenceId: refId, authCode: saleResponse?.AuthCode });
  } catch (err) {
    log('SPIN_SALE_FAILED', { message: err.message, referenceId: refId });
    await persistEvents(sessionId, events);
    throw new CheckoutSessionError(`Sale declined: ${err.message}`, 402, 'SALE_DECLINED');
  }

  // ── 2. Extract + persist card-on-file (sale always tokenizes) ──────
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
    logger.warn('[spin-charge] sale approved but no card-on-file token', { sessionId, refId });
  }

  // ── 3. Persist payment row ─────────────────────────────────────────
  const saleReference = saleResponse?.AuthCode || refId;
  const saleNotes = `Spin Sale · ${refId}`;
  const payment = await prisma.rentalAgreementPayment.create({
    data: {
      rentalAgreementId: session.agreement.id,
      method: 'CARD',
      amount: requestedAmount,
      reference: saleReference,
      status: 'PAID',
      notes: saleNotes,
    },
  });
  // Mirror into ReservationPayment so View Payments shows it.
  await mirrorToReservationPayment({
    reservationId: session.reservation.id,
    agreementPaymentId: payment.id,
    method: 'CARD',
    amount: requestedAmount,
    reference: saleReference,
    notes: saleNotes,
  });
  log('SALE_PAYMENT_RECORDED', { amount: requestedAmount, paymentId: payment.id });

  // ── 4. Append events, do NOT stamp paymentCompletedAt yet ──────────
  await persistEvents(sessionId, [...events, {
    kind: 'SALE_COMPLETE', actorUserId: actorUserId || null,
  }]);

  return {
    sessionId,
    refId,
    paymentId: payment.id,
    sale: spinClient.normalizeResponse(saleResponse),
    cardOnFile,
    amount: requestedAmount,
  };
}

/**
 * Step 3b — Hold the security deposit as a CARD-NOT-PRESENT pre-auth
 * using the iPOS Token captured by runSale on the prior tap. NO second
 * physical card tap from the customer — the terminal doesn't prompt;
 * the auth goes through the Dejavoo cloud against the saved token.
 *
 * Per Hector's 2026-05-29 conversation with Dejavoo: this is the
 * partner-recommended flow. The original two-tap design is dropped.
 *
 * Reads the deposit amount from the AGREEMENT (column → SECURITY_DEPOSIT
 * charge sum → wizard hint → default). On success persists the
 * depositHoldId + expiry on the agreement and stamps
 * paymentCompletedAt on the session so the wizard auto-advances.
 *
 * Pre-paid customers (no prior sale, so no saved token): fall back to a
 * fresh card tap. The terminal will prompt for tap/insert/swipe and
 * the auth response will tokenize the card opportunistically.
 *
 * Failure mode: returns an error but does NOT void the sale. The agent
 * can re-try from the wizard or from View Payments later.
 */
async function runDepositHold({ sessionId, depositAmount: depositAmountHint, actorUserId }) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);

  const session = await loadSessionAndAgreement(sessionId, ['TC_SIGNED', 'PAYMENT_PENDING']);
  const agreement = session.agreement;

  if (agreement.depositHoldId) {
    throw new CheckoutSessionError(
      'A deposit hold is already on file for this agreement. Release it first via View Payments.',
      409, 'DEPOSIT_ALREADY_HELD',
    );
  }

  const depositAmount = resolveDepositAmount(agreement, depositAmountHint);
  if (depositAmount <= 0) {
    // Zero deposit — nothing to hold, just stamp the session as paid
    // so the wizard advances.
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: {
        paymentCompletedAt: new Date(),
        events: appendEvents(session.events, [{
          kind: 'DEPOSIT_SKIPPED_ZERO', actorUserId: actorUserId || null, at: new Date().toISOString(),
        }]),
      },
    });
    return { sessionId, skipped: true, reason: 'zero-deposit' };
  }

  const tenantConfig = await loadTenantSpinConfig(session.reservation.tenantId).catch(() => ({}));
  const depositRefId = `${session.reservation.reservationNumber}-DEP-${Date.now().toString(36)}`;
  const events = [];
  const log = (kind, payload) => events.push({ kind, ...payload, at: new Date().toISOString() });

  // ── 1. Pre-auth ─────────────────────────────────────────────────────
  //
  // Two paths per the Dejavoo docs:
  //
  // (a) Token path (after a card-present sale) — uses the iPOSpays
  //     Transact API CNP pre-auth (transactionType 5) with the saved
  //     iPOS Token. NO second tap, NO terminal interaction. This is
  //     the documented path for tokenized CNP.
  //     Docs: https://docs.ipospays.com/ipos-transact/apidocs#pre-auth
  //
  // (b) Card-present path (pre-paid customers, no prior sale) — still
  //     goes through SPIn /v2/Payment/Auth at the physical terminal so
  //     the response can tokenize the card for post-rental incidentals.
  const useTokenPath = Boolean(agreement.cardOnFileToken);
  let preauthResponse;
  let preauthNorm;
  // Where we store the hold key. For Transact, depositHoldId holds the
  // RRN (the void key). For SPIn, depositHoldId holds the ReferenceId
  // (also the void key). Both paths end up writable by the View
  // Payments "Release deposit" button.
  let holdKey = depositRefId;
  let authCode = '';

  try {
    if (useTokenPath) {
      log('IPOS_PREAUTH_STARTED', {
        depositAmount, referenceId: depositRefId, mode: 'CNP',
      });
      // Fetch customer info for Transact preferences block (eReceipt is
      // false; customer info populates the iPOSpays transactions portal
      // for support traceability).
      const customer = await prisma.customer.findFirst({
        where: { id: session.reservation.customerId || undefined },
        select: { firstName: true, lastName: true, email: true, phone: true },
      }).catch(() => null);
      preauthResponse = await iposTransactClient.preAuthDeposit({
        amount: depositAmount,
        agreementNumber: agreement.agreementNumber || agreement.id,
        cardToken: agreement.cardOnFileToken,
        customer: customer ? {
          name: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
          email: customer.email || '',
          phone: customer.phone || '',
        } : undefined,
      }, tenantConfig);
      preauthNorm = iposTransactClient.normalizeResponse(preauthResponse);
      if (!preauthNorm.approved) {
        throw new Error(preauthNorm.errMessage || preauthNorm.message || 'declined');
      }
      // Transact returns RRN — that's our void key.
      holdKey = preauthNorm.rrn || depositRefId;
      authCode = preauthNorm.authCode;
      log('IPOS_PREAUTH_APPROVED', { rrn: holdKey, authCode });
    } else {
      log('SPIN_PREAUTH_STARTED', {
        depositAmount, referenceId: depositRefId, mode: 'CARD_PRESENT',
      });
      preauthResponse = await spinClient.preAuthDeposit({
        amount: depositAmount,
        referenceId: depositRefId,
        invoiceNumber: agreement.agreementNumber,
      }, tenantConfig);
      holdKey = depositRefId;
      authCode = preauthResponse?.AuthCode || '';
      log('SPIN_PREAUTH_APPROVED', { referenceId: depositRefId, authCode });
    }
  } catch (err) {
    log('PREAUTH_FAILED', { message: err.message, mode: useTokenPath ? 'CNP' : 'CARD_PRESENT' });
    await persistEvents(sessionId, events);
    throw new CheckoutSessionError(
      useTokenPath
        ? `Deposit hold declined: ${err.message}. The sale is unchanged. Try again or release manually from View Payments.`
        : `Deposit hold declined: ${err.message}. Retry the hold from this screen.`,
      402, 'DEPOSIT_HOLD_DECLINED',
    );
  }

  // ── 2. If card-present (no token yet), capture the card-on-file
  //       from the SPIn auth response. Token-path agreements already
  //       have the token from runSale.
  let cardOnFile = null;
  if (useTokenPath) {
    cardOnFile = { token: agreement.cardOnFileToken, brand: agreement.cardOnFileBrand, last4: agreement.cardOnFileLast4 };
  } else {
    cardOnFile = spinClient.extractCardOnFile(preauthResponse);
    if (cardOnFile) {
      await prisma.rentalAgreement.update({
        where: { id: agreement.id },
        data: {
          cardOnFileToken: cardOnFile.token,
          cardOnFileBrand: cardOnFile.brand,
          cardOnFileLast4: cardOnFile.last4,
          cardOnFileCapturedAt: cardOnFile.capturedAt,
        },
      });
      log('CARD_ON_FILE_CAPTURED_FROM_DEPOSIT', { brand: cardOnFile.brand, last4: cardOnFile.last4 });
    }
  }

  // ── 3. Persist deposit hold metadata + mirror to ReservationPayment
  //       + stamp the session as paid so the wizard auto-advances.
  await mirrorToReservationPayment({
    reservationId: session.reservation.id,
    method: 'AUTH_HOLD',
    amount: depositAmount,
    reference: `${useTokenPath ? 'IPOS' : 'SPIN'}_HOLD:${authCode || holdKey}`,
    notes: `Deposit hold · ${holdKey}${useTokenPath ? ' (Transact CNP via iPOS Token)' : ' (SPIn card-present)'}`,
  });

  await prisma.rentalAgreement.update({
    where: { id: agreement.id },
    data: {
      depositHoldId: holdKey,
      depositHoldAmount: depositAmount,
      depositHoldExpiresAt: new Date(Date.now() + DEPOSIT_HOLD_EXPIRES_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  log('DEPOSIT_HOLD_PERSISTED', { holdKey, amount: depositAmount });

  await prisma.checkoutSession.update({
    where: { id: sessionId },
    data: {
      paymentCompletedAt: new Date(),
      events: appendEvents(session.events, events, {
        kind: 'DEPOSIT_HOLD_COMPLETE', actorUserId: actorUserId || null,
      }),
    },
  });

  return {
    sessionId,
    depositRefId: holdKey,
    preauth: useTokenPath ? preauthNorm : spinClient.normalizeResponse(preauthResponse),
    cardOnFile,
    amount: depositAmount,
    mode: useTokenPath ? 'CNP' : 'CARD_PRESENT',
  };
}

// =====================================================================
// Manual-override failsafes (2026-05-29)
//
// The terminal can fail in production — network drops, paper jam,
// Dejavoo cloud outage, customer's card declines and they hand the agent
// a different one outside the wizard. When that happens the agent needs
// a way to record what actually happened (cash collected, external auth,
// check) and unblock the rest of the checkout WITHOUT pretending the
// Spin terminal succeeded.
//
// These methods write the same RentalAgreementPayment row that the
// Spin orchestrator writes, just sourced from `method: 'CASH' | 'CHECK'
// | 'CARD'` with a clear `notes` audit trail. The session is stamped
// the same way so the wizard auto-advances identically.
// =====================================================================

const MANUAL_PAYMENT_METHODS = ['CASH', 'CHECK', 'CARD', 'OTHER'];

/**
 * Record a manual sale payment (terminal bypass). Used when the Dejavoo
 * terminal fails or when the agent collected payment in a different way
 * (front-desk cash drawer, external card swipe on a backup reader, etc).
 *
 * Body shape:
 *   { sessionId, amount, method, reference?, notes?, actorUserId }
 *
 * Behaves like runSale's persistence half — writes a RentalAgreementPayment
 * row — but doesn't touch the terminal or capture a card-on-file token.
 * That means a follow-up deposit hold cannot use the saved-card CNP path
 * (no token), so the deposit step will need its own manual or fresh-tap
 * fallback.
 */
async function recordManualSale({
  sessionId, amount, method, reference, notes, actorUserId,
}) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);
  const requestedAmount = Number(amount);
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    throw new CheckoutSessionError('amount must be positive', 400);
  }
  const upperMethod = String(method || '').toUpperCase();
  if (!MANUAL_PAYMENT_METHODS.includes(upperMethod)) {
    throw new CheckoutSessionError(
      `method must be one of: ${MANUAL_PAYMENT_METHODS.join(', ')}`,
      400,
    );
  }

  const session = await loadSessionAndAgreement(sessionId, ['TC_SIGNED', 'PAYMENT_PENDING']);
  const refId = reference?.trim() || `MANUAL-${Date.now().toString(36)}`;

  const manualSaleNotes = notes
    ? `Manual sale (${upperMethod}) · ${notes}`
    : `Manual sale (${upperMethod}) · terminal bypass`;
  const payment = await prisma.rentalAgreementPayment.create({
    data: {
      rentalAgreementId: session.agreement.id,
      method: upperMethod,
      amount: requestedAmount,
      reference: refId,
      status: 'PAID',
      notes: manualSaleNotes,
    },
  });
  // Mirror into ReservationPayment so the rental agent sees the manual
  // entry on the View Payments page right after the wizard advances.
  await mirrorToReservationPayment({
    reservationId: session.reservation.id,
    agreementPaymentId: payment.id,
    method: upperMethod,
    amount: requestedAmount,
    reference: refId,
    notes: manualSaleNotes,
  });

  await persistEvents(sessionId, [
    {
      kind: 'MANUAL_SALE_RECORDED',
      amount: requestedAmount,
      method: upperMethod,
      reference: refId,
      actorUserId: actorUserId || null,
      at: new Date().toISOString(),
    },
  ]);

  logger.info('[spin-charge] manual sale recorded', {
    sessionId, paymentId: payment.id, amount: requestedAmount, method: upperMethod,
  });

  return {
    sessionId,
    paymentId: payment.id,
    amount: requestedAmount,
    method: upperMethod,
    reference: refId,
    manual: true,
  };
}

/**
 * Record a manual deposit hold (terminal bypass). Used for cash deposits
 * the agent holds at the counter, external authorizations, or "waived"
 * scenarios with an explicit reason.
 *
 * Persists depositHoldId + depositHoldAmount on the agreement and stamps
 * paymentCompletedAt on the session so the wizard advances. The cleanup
 * job won't try to void a manual hold (depositHoldId starts with
 * "MANUAL-" so the spin-cleanup checks can short-circuit).
 *
 * Reason is required so audits can see WHY the manual override was used.
 */
async function recordManualDeposit({
  sessionId, amount, method, reference, reason, actorUserId,
}) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);
  if (!reason || String(reason).trim().length < 3) {
    throw new CheckoutSessionError('reason is required for manual deposit (audit trail)', 400);
  }
  const requestedAmount = Number(amount);
  if (!Number.isFinite(requestedAmount) || requestedAmount < 0) {
    throw new CheckoutSessionError('amount must be non-negative', 400);
  }
  const upperMethod = String(method || 'CASH').toUpperCase();
  if (!MANUAL_PAYMENT_METHODS.includes(upperMethod) && upperMethod !== 'WAIVED') {
    throw new CheckoutSessionError(
      `method must be one of: ${MANUAL_PAYMENT_METHODS.join(', ')}, WAIVED`,
      400,
    );
  }

  const session = await loadSessionAndAgreement(sessionId, ['TC_SIGNED', 'PAYMENT_PENDING']);
  const agreement = session.agreement;

  if (agreement.depositHoldId) {
    throw new CheckoutSessionError(
      'A deposit hold is already on file. Release it via View Payments before recording a new one.',
      409, 'DEPOSIT_ALREADY_HELD',
    );
  }

  const depositRefId = reference?.trim() || `MANUAL-${session.reservation.reservationNumber}-${Date.now().toString(36)}`;

  await prisma.rentalAgreement.update({
    where: { id: agreement.id },
    data: {
      depositHoldId: depositRefId,
      depositHoldAmount: requestedAmount,
      // Manual holds don't have a settled expiry — set to 7 days from now
      // by convention so the nightly cleanup still nudges staff to close
      // them out if they're forgotten.
      depositHoldExpiresAt: new Date(Date.now() + DEPOSIT_HOLD_EXPIRES_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  // Mirror an AUTH_HOLD row into ReservationPayment so the manual hold
  // surfaces on View Payments. WAIVED holds with $0 still post (rare,
  // but the agent should be able to see WHY no hold was placed —
  // reason is in the notes).
  const manualDepositNotes = `Manual deposit hold (${upperMethod}) · ${String(reason).trim().slice(0, 240)}`;
  await mirrorToReservationPayment({
    reservationId: session.reservation.id,
    method: upperMethod === 'WAIVED' ? 'OTHER' : 'AUTH_HOLD',
    amount: requestedAmount,
    reference: depositRefId,
    notes: manualDepositNotes,
  });

  await prisma.checkoutSession.update({
    where: { id: sessionId },
    data: {
      paymentCompletedAt: new Date(),
      events: appendEvents(session.events, [{
        kind: 'MANUAL_DEPOSIT_RECORDED',
        amount: requestedAmount,
        method: upperMethod,
        reason: String(reason).trim().slice(0, 500),
        reference: depositRefId,
        actorUserId: actorUserId || null,
        at: new Date().toISOString(),
      }]),
    },
  });

  logger.info('[spin-charge] manual deposit recorded', {
    sessionId, depositRefId, amount: requestedAmount, method: upperMethod, reason,
  });

  return {
    sessionId,
    depositRefId,
    amount: requestedAmount,
    method: upperMethod,
    reason,
    manual: true,
  };
}

export const spinChargeService = {
  runChargeSequence,    // legacy one-shot (sale + preauth) — kept for backward compat
  runSale,              // 2026-05-29 two-tap step 3a (CNP via iPOS token for step 3b)
  runDepositHold,       // 2026-05-29 two-tap step 3b
  recordManualSale,     // 2026-05-29 terminal-bypass failsafe
  recordManualDeposit,  // 2026-05-29 terminal-bypass failsafe
};
