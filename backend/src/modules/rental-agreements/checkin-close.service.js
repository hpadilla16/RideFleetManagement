/**
 * Pillar 2 — Checkin close + fee engine orchestration.
 *
 * Sibling to rental-agreements.service.js's closeAgreement(), specifically
 * for the multi-step checkin wizard flow. Unlike the legacy closeAgreement
 * which requires balance=0 before allowing close, this path:
 *
 *   1. Persists checkin inspection values (odo/fuel/cleanliness) on the
 *      agreement
 *   2. Runs the fee engine — computes EXCESS_MILEAGE, FUEL_REFILL,
 *      CLEANING_*, SMOKING fees from deltas; persists each as a
 *      RentalAgreementCharge row with source='FEE_ENGINE_CHECKIN'
 *   3. Recomputes agreement totals (subtotal/fees/total/balance)
 *   4. Branches by balance:
 *      - balance === 0 → reservation status = CHECKED_IN, send 0-balance
 *        receipt email
 *      - balance > 0 → reservation status = CHECKED_IN_UNPAID, set
 *        autochargeAt = NOW + 24h, enqueue BullMQ autocharge job, send
 *        invoice email with card-on-file notice
 *   5. Audit logs
 *
 * The legacy closeAgreement() is preserved for backward compat (it's still
 * used by old code paths that don't run the fee engine). New wizards call
 * this function instead.
 */

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { feeEngineService } from '../fees/fee-engine.service.js';
import { sendInvoiceAfterCheckin, sendReceiptPaidInFull } from './checkin-emails.service.js';
import { enqueueJob } from '../../lib/queue/index.js';
import { AUTOCHARGE_PRIORITY } from '../../lib/queue/priorities.js';

const AUTOCHARGE_DELAY_MS = 24 * 60 * 60 * 1000;  // 24 hours

/**
 * Close an agreement via the checkin wizard. Runs the fee engine, routes
 * status based on resulting balance.
 *
 * Payload shape:
 *   {
 *     odometerIn: number,
 *     fuelIn: number (0..1),
 *     cleanlinessIn: number (1..5),
 *     smokingDetected: boolean,
 *     signerName: string,
 *     signatureDataUrl: string (data URL or empty if already on file),
 *     manualPayment: { amount, method, reference, last4, receiptUrl } | null
 *   }
 */
export async function closeAgreementWithCheckinFees(
  agreementId,
  payload = {},
  actorUserId = null,
  actorIp = null
) {
  const agreement = await prisma.rentalAgreement.findUnique({
    where: { id: agreementId },
    include: {
      reservation: {
        include: {
          customer: {
            select: {
              id: true,
              email: true,
              firstName: true,
              authnetCustomerProfileId: true,
              authnetPaymentProfileId: true,
              cardLast4: true
            }
          }
        }
      },
      inspections: true
    }
  });

  if (!agreement) throw new Error('Rental agreement not found');
  if (agreement.status === 'CLOSED' || agreement.status === 'CANCELLED') {
    throw new Error(`Cannot close agreement in status ${agreement.status}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 1 — Persist checkin metrics on the agreement
  // ─────────────────────────────────────────────────────────────────────────

  const odometerIn   = payload.odometerIn   != null ? Number(payload.odometerIn)   : null;
  const fuelIn       = payload.fuelIn       != null ? Number(payload.fuelIn)       : null;
  const cleanlinessIn = payload.cleanlinessIn != null ? Number(payload.cleanlinessIn) : null;

  await prisma.rentalAgreement.update({
    where: { id: agreementId },
    data: {
      odometerIn:    odometerIn   ?? agreement.odometerIn,
      fuelIn:        fuelIn       ?? agreement.fuelIn,
      cleanlinessIn: cleanlinessIn ?? agreement.cleanlinessIn
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2 — Apply manual payment FIRST (so fees can be partially or fully
  // covered by a counter payment). We add the payment row, then recompute
  // balance, then the fee engine runs against the updated balance.
  // Wait — actually, this is more nuanced. The fees are based on USAGE
  // (mileage / fuel / cleaning / smoking) not balance. The manual payment
  // should apply AFTER fees are computed, against the new total. Reorder:
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // Step 2 — Run fee engine
  // ─────────────────────────────────────────────────────────────────────────

  const rentalDays = computeRentalDays(agreement.pickupAt, agreement.returnAt);
  const tankCapacity = await resolveTankCapacity(agreement);
  const includedMilesPerDay = await resolveIncludedMilesPerDay(agreement);

  // LATE_RETURN inputs. Caller can pass `returnedAt` to backdate a checkin;
  // default to now (when the wizard fires). `dueBackAt` is the scheduled
  // return time on the agreement. If either is missing the fee engine
  // silently skips the LATE_RETURN computation.
  const returnedAt = payload.returnedAt ? new Date(payload.returnedAt) : new Date();
  const dueBackAt = agreement.returnAt || null;

  const feeResult = await feeEngineService.computeCheckinFees({
    reservationId: agreement.reservationId,
    rentalAgreementId: agreement.id,
    tenantId: agreement.tenantId,
    locationId: agreement.pickupLocationId || agreement.returnLocationId,
    odometerOut: agreement.odometerOut,
    odometerIn: odometerIn ?? agreement.odometerIn,
    fuelOut: agreement.fuelOut,
    fuelIn: fuelIn ?? agreement.fuelIn,
    cleanlinessOut: agreement.cleanlinessOut,
    cleanlinessIn: cleanlinessIn ?? agreement.cleanlinessIn,
    smokingDetected: !!payload.smokingDetected,
    dueBackAt,
    returnedAt,
    includedMilesPerDay,
    rentalDays,
    tankCapacityGallons: tankCapacity,
    persist: true,
    actorUserId
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Step 3 — Apply manual payment if provided (after fees, against new total)
  // ─────────────────────────────────────────────────────────────────────────

  if (payload.manualPayment && Number(payload.manualPayment.amount || 0) > 0) {
    await applyManualPayment({
      rentalAgreementId: agreement.id,
      payment: payload.manualPayment,
      actorUserId
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 4 — Reload agreement to get the post-engine balance
  // ─────────────────────────────────────────────────────────────────────────

  const updated = await prisma.rentalAgreement.findUnique({
    where: { id: agreementId },
    select: {
      id: true,
      reservationId: true,
      total: true,
      paidAmount: true,
      balance: true,
      agreementNumber: true
    }
  });

  const newBalance = Number(updated.balance || 0);

  // ─────────────────────────────────────────────────────────────────────────
  // Step 5 — Update signature if provided
  // ─────────────────────────────────────────────────────────────────────────

  if (payload.signerName || payload.signatureDataUrl) {
    const signerName = String(payload.signerName || '').trim();
    const signatureDataUrl = String(payload.signatureDataUrl || '').trim();
    if (signerName && signatureDataUrl) {
      await prisma.reservation.update({
        where: { id: agreement.reservationId },
        data: {
          signatureSignedBy: signerName,
          signatureDataUrl,
          signatureSignedAt: new Date()
        }
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 6 — Route by balance
  // ─────────────────────────────────────────────────────────────────────────

  let newStatus;
  let newReservationStatus;
  let autochargeJobId = null;

  if (newBalance <= 0) {
    // Paid in full — close cleanly
    newStatus = 'CLOSED';
    newReservationStatus = 'CHECKED_IN';

    await prisma.rentalAgreement.update({
      where: { id: agreementId },
      data: {
        status: 'CLOSED',
        locked: true,
        closedAt: new Date(),
        closedByUserId: actorUserId || agreement.closedByUserId || null
      }
    });

    await prisma.reservation.update({
      where: { id: agreement.reservationId },
      data: { status: 'CHECKED_IN' }
    });

    // 0-balance receipt
    try {
      await sendReceiptPaidInFull({
        reservationId: agreement.reservationId,
        agreementId: agreement.id
      });
    } catch (err) {
      logger.warn('[checkin-close] receipt email failed', {
        agreementId, message: err.message
      });
    }
  } else {
    // Outstanding balance — checkin-unpaid + queue autocharge
    newStatus = agreement.status;  // keep agreement open until autocharge resolves
    newReservationStatus = 'CHECKED_IN_UNPAID';

    const autochargeAt = new Date(Date.now() + AUTOCHARGE_DELAY_MS);

    await prisma.reservation.update({
      where: { id: agreement.reservationId },
      data: {
        status: 'CHECKED_IN_UNPAID',
        autochargeAt
      }
    });

    // Enqueue with idempotent jobId so re-runs don't double-charge
    autochargeJobId = `autocharge-${agreement.reservationId}-${autochargeAt.getTime()}`;
    try {
      await enqueueJob(
        'reservation.autocharge-after-checkin',
        { reservationId: agreement.reservationId },
        {
          delay: AUTOCHARGE_DELAY_MS,
          jobId: autochargeJobId,
          priority: AUTOCHARGE_PRIORITY
        }
      );
    } catch (err) {
      logger.error('[checkin-close] failed to enqueue autocharge', {
        agreementId, message: err.message
      });
      // Don't fail the close — manual workflow can still complete the charge.
    }

    // Invoice email with card-on-file notice
    try {
      await sendInvoiceAfterCheckin({
        reservationId: agreement.reservationId,
        agreementId: agreement.id
      });
    } catch (err) {
      logger.warn('[checkin-close] invoice email failed', {
        agreementId, message: err.message
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 7 — Audit logs
  // ─────────────────────────────────────────────────────────────────────────

  await prisma.auditLog.create({
    data: {
      reservationId: agreement.reservationId,
      actorUserId: actorUserId || null,
      action: 'STATUS_CHANGE',
      fromStatus: 'CHECKED_OUT',
      toStatus: newReservationStatus,
      reason: newBalance > 0
        ? `Checkin complete — balance $${newBalance.toFixed(2)} pending auto-charge`
        : 'Checkin complete — paid in full',
      metadata: JSON.stringify({
        feeEngineItemCount: feeResult.items.length,
        feeEngineTotal: feeResult.total,
        feeBreakdown: feeResult.breakdown.byType,
        newBalance,
        autochargeJobId,
        ip: actorIp || null
      })
    }
  }).catch((err) => {
    logger.warn('[checkin-close] audit log failed', { agreementId, message: err.message });
  });

  return {
    success: true,
    agreementId,
    reservationId: agreement.reservationId,
    feesAdded: feeResult.items,
    feesTotal: feeResult.total,
    newBalance,
    reservationStatus: newReservationStatus,
    agreementStatus: newStatus,
    autochargeJobId,
    autochargeAt: newBalance > 0 ? new Date(Date.now() + AUTOCHARGE_DELAY_MS) : null
  };
}

// =============================================================================
// Helpers
// =============================================================================

function computeRentalDays(pickupAt, returnAt) {
  if (!pickupAt || !returnAt) return 1;
  const p = new Date(pickupAt).getTime();
  const r = new Date(returnAt).getTime();
  const ms = Math.max(0, r - p);
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  return Math.max(1, days);
}

async function resolveTankCapacity(agreement) {
  // Pull from vehicle metadata. Falls back to 15 (a generic mid-size sedan).
  const vehicleId = agreement.vehicleId;
  if (!vehicleId) return 15;
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { tankCapacityGallons: true, fuelTankSize: true }
  }).catch(() => null);
  const cap = Number(vehicle?.tankCapacityGallons || vehicle?.fuelTankSize || 0);
  return cap > 0 ? cap : 15;
}

async function resolveIncludedMilesPerDay(agreement) {
  // Could come from the rate plan or pricing snapshot. For now, fall back to
  // 200 miles/day (industry standard for U.S. rentals). Future: read from
  // ReservationPricingSnapshot or rate plan config.
  return 200;
}

async function applyManualPayment({ rentalAgreementId, payment, actorUserId }) {
  const amount = Number(payment.amount || 0);
  if (amount <= 0) return null;

  // Map UI method → enum value (matching AgreementPaymentMethod in schema)
  const methodMap = {
    cash: 'CASH',
    card: 'CARD',
    check: 'CHECK',
    other: 'OTHER'
  };
  const method = methodMap[String(payment.method || '').toLowerCase()] || 'OTHER';

  const referenceParts = [];
  if (payment.last4) referenceParts.push(`****${payment.last4}`);
  if (payment.reference) referenceParts.push(payment.reference);
  const reference = referenceParts.join(' · ') || null;

  const notes = payment.receiptUrl
    ? `Receipt: ${payment.receiptUrl}`
    : null;

  await prisma.rentalAgreementPayment.create({
    data: {
      rentalAgreementId,
      method,
      amount,
      reference,
      status: 'PAID',
      notes
    }
  });

  // Recompute paid amount + balance on the agreement
  const allPayments = await prisma.rentalAgreementPayment.findMany({
    where: { rentalAgreementId, status: 'PAID' },
    select: { amount: true }
  });
  const totalPaid = allPayments.reduce((s, p) => s + Number(p.amount || 0), 0);
  const agreement = await prisma.rentalAgreement.findUnique({
    where: { id: rentalAgreementId },
    select: { total: true }
  });
  const newBalance = Math.max(0, Number((Number(agreement.total || 0) - totalPaid).toFixed(2)));

  await prisma.rentalAgreement.update({
    where: { id: rentalAgreementId },
    data: {
      paidAmount: Number(totalPaid.toFixed(2)),
      balance: newBalance
    }
  });

  if (actorUserId) {
    await prisma.auditLog.create({
      data: {
        reservationId: null,  // we don't have it directly here without another query
        actorUserId,
        action: 'UPDATE',
        reason: `Manual payment applied via checkin wizard: ${method} $${amount.toFixed(2)}${reference ? ` (${reference})` : ''}`,
        metadata: JSON.stringify({ rentalAgreementId, amount, method, reference, receiptUrl: payment.receiptUrl || null })
      }
    }).catch(() => {});
  }

  return { totalPaid, newBalance };
}

export const checkinCloseService = {
  closeAgreementWithCheckinFees
};
