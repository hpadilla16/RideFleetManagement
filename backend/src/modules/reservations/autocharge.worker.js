/**
 * Pillar 2 — Auto-charge worker handler.
 *
 * Picks up reservation.autocharge-after-checkin jobs from the BullMQ queue
 * and charges the customer's card-on-file (Authorize.Net CIM token) for the
 * outstanding balance.
 *
 * Flow:
 *   1. Load reservation + linked agreement + customer.
 *   2. Pre-flight checks:
 *      - reservation.status = CHECKED_IN_UNPAID
 *      - reservation.autochargeBlocked = false (pre-update terms gate)
 *      - balance > 0 (might have been paid manually in the meantime)
 *      - customer has authnetCustomerProfileId + authnetPaymentProfileId
 *   3. Call existing rentalAgreementsService.chargeCardOnFile(agreementId, {amount}).
 *   4. On success:
 *      - Increment autochargeAttempts, clear autochargeLastError
 *      - Status: CHECKED_IN_UNPAID → CHECKED_IN
 *      - Send receipt-paid-in-full email
 *      - Audit log
 *   5. On failure:
 *      - Increment autochargeAttempts, set autochargeLastError
 *      - Status stays CHECKED_IN_UNPAID
 *      - Email staff (configurable recipient) — never email customer
 *      - Throw to trigger BullMQ retry per backoff config
 *
 * Feature flag (ADD LATER once card metadata + terms are in place):
 *   tenant feature flag autochargeEnabled must be true. Until that flag
 *   exists, this worker is dispatched ONLY by code paths that have
 *   confirmed the agreement was signed under post-update terms.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

export async function autochargeHandler(job) {
  const { reservationId } = job.data;
  if (!reservationId) {
    throw new Error('autochargeHandler: missing reservationId in job data');
  }

  // 1. Load reservation + agreement + customer
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: {
      customer: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          authnetCustomerProfileId: true,
          authnetPaymentProfileId: true,
          cardLast4: true,
          cardBrand: true
        }
      }
    }
  });

  if (!reservation) {
    logger.error('[autocharge] reservation not found — skipping', { reservationId });
    return { skipped: true, reason: 'reservation_not_found' };
  }

  const status = String(reservation.status || '').toUpperCase();

  // 2. Pre-flight checks
  if (status !== 'CHECKED_IN_UNPAID') {
    logger.info('[autocharge] reservation no longer CHECKED_IN_UNPAID — skipping', {
      reservationId, status
    });
    return { skipped: true, reason: 'status_changed', currentStatus: status };
  }

  if (reservation.autochargeBlocked) {
    logger.warn('[autocharge] reservation autochargeBlocked — skipping', { reservationId });
    return { skipped: true, reason: 'autocharge_blocked' };
  }

  // Find the linked agreement to get the latest balance
  const agreement = await prisma.rentalAgreement.findUnique({
    where: { reservationId: reservation.id },
    select: {
      id: true,
      tenantId: true,
      agreementNumber: true,
      balance: true,
      total: true,
      paidAmount: true
    }
  });

  if (!agreement) {
    logger.error('[autocharge] no agreement for reservation', { reservationId });
    return { skipped: true, reason: 'no_agreement' };
  }

  const balance = Number(agreement.balance || 0);

  if (balance <= 0) {
    logger.info('[autocharge] balance already 0 — transitioning to CHECKED_IN', {
      reservationId, balance
    });
    await prisma.reservation.update({
      where: { id: reservation.id },
      data: { status: 'CHECKED_IN' }
    });
    return { skipped: true, reason: 'balance_zero', autoTransitioned: true };
  }

  if (!reservation.customer?.authnetCustomerProfileId || !reservation.customer?.authnetPaymentProfileId) {
    const err = new Error('Customer has no CIM tokens on file');
    await markAutochargeFailure(reservation.id, err.message);
    await notifyStaffAutochargeFailed({
      reservationId, agreement, customer: reservation.customer, balance,
      reason: 'No card-on-file token. Staff must collect payment manually.'
    });
    throw err;
  }

  // 3. Charge the card via the existing service
  const { rentalAgreementsService } = await import('../rental-agreements/rental-agreements.service.js');

  try {
    await rentalAgreementsService.chargeCardOnFile(
      agreement.id,
      { amount: balance },
      null  // actorUserId — system-initiated, no human user
    );
  } catch (err) {
    await markAutochargeFailure(reservation.id, err.message || String(err));
    await notifyStaffAutochargeFailed({
      reservationId, agreement, customer: reservation.customer, balance,
      reason: err.message || String(err)
    });
    throw err;  // bullmq retry per backoff
  }

  // 4. Success — transition status + send receipt + audit
  await prisma.reservation.update({
    where: { id: reservation.id },
    data: {
      status: 'CHECKED_IN',
      autochargeAttempts: { increment: 1 },
      autochargeLastError: null
    }
  });

  await prisma.auditLog.create({
    data: {
      reservationId: reservation.id,
      actorUserId: null,
      // AuditAction has no AUTOCHARGE_* value — this is a status transition
      // (CHECKED_IN_UNPAID -> CHECKED_IN); the autocharge detail lives in
      // metadata.event so it stays queryable.
      action: 'STATUS_CHANGE',
      fromStatus: 'CHECKED_IN_UNPAID',
      toStatus: 'CHECKED_IN',
      reason: `Auto-charged $${balance.toFixed(2)} to card ending ${reservation.customer.cardLast4 || '????'}`,
      metadata: JSON.stringify({
        event: 'AUTOCHARGE_SUCCESS',
        agreementId: agreement.id,
        amount: balance,
        cardLast4: reservation.customer.cardLast4,
        cardBrand: reservation.customer.cardBrand,
        jobId: job.id
      })
    }
  }).catch((err) => {
    // Audit log failure is non-fatal — the charge succeeded.
    logger.warn('[autocharge] audit log failed', { reservationId, message: err.message });
  });

  // Send receipt — dynamic import to avoid circular dependency
  try {
    const { sendReceiptPaidInFull } = await import('../rental-agreements/checkin-emails.service.js');
    await sendReceiptPaidInFull({ reservationId, agreementId: agreement.id });
    // 2026-07-28 (LAX #8): this success receipt IS the post-check-in email.
    // Stamp checkinEmailSentAt so a pending delayed send (checkinEmailDueAt)
    // doesn't deliver a second one.
    await prisma.reservation.update({
      where: { id: reservationId },
      data: { checkinEmailSentAt: new Date() },
    }).catch(() => {});
  } catch (err) {
    logger.warn('[autocharge] receipt email failed', { reservationId, message: err.message });
  }

  logger.info('[autocharge] charge succeeded', {
    reservationId,
    agreementId: agreement.id,
    amount: balance,
    cardLast4: reservation.customer.cardLast4
  });

  return { success: true, amount: balance };
}

// =============================================================================
// Failure helpers
// =============================================================================

async function markAutochargeFailure(reservationId, errorMessage) {
  await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      autochargeAttempts: { increment: 1 },
      autochargeLastError: String(errorMessage || '').slice(0, 500)
    }
  }).catch((err) => {
    logger.warn('[autocharge] failed to mark failure on reservation', {
      reservationId, message: err.message
    });
  });
}

async function notifyStaffAutochargeFailed({ reservationId, agreement, customer, balance, reason }) {
  const recipient = process.env.AUTOCHARGE_FAILURE_NOTIFICATION_EMAIL
    || process.env.OPS_NOTIFICATION_EMAIL
    || '';

  if (!recipient) {
    logger.warn('[autocharge] no AUTOCHARGE_FAILURE_NOTIFICATION_EMAIL configured');
    return;
  }

  try {
    const { sendEmail } = await import('../../lib/mailer.js');
    await sendEmail({
      to: recipient,
      subject: `[Auto-charge FAILED] ${agreement.agreementNumber} — $${balance.toFixed(2)} owed`,
      html: `
        <h3>Auto-charge failed</h3>
        <p><strong>Agreement:</strong> ${agreement.agreementNumber}</p>
        <p><strong>Reservation ID:</strong> ${reservationId}</p>
        <p><strong>Customer:</strong> ${customer?.firstName || ''} ${customer?.lastName || ''} &lt;${customer?.email || 'no email'}&gt;</p>
        <p><strong>Balance owed:</strong> $${balance.toFixed(2)}</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>Reservation remains in CHECKED_IN_UNPAID status. Please collect payment manually.</p>
      `,
      text: `Auto-charge failed for ${agreement.agreementNumber}.\nAmount: $${balance.toFixed(2)}\nReason: ${reason}\nCustomer: ${customer?.email || 'no email'}`
    });
  } catch (err) {
    logger.error('[autocharge] failed to send staff notification', { message: err.message });
  }
}
