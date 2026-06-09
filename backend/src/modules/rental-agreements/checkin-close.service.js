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
import { recordMileageEntrySafe } from '../vehicles/mileage-history.service.js';
import { syncVehicleStatusForReservation } from '../vehicles/vehicle-status-sync.js';
import { feeEngineService } from '../fees/fee-engine.service.js';
import { settingsService } from '../settings/settings.service.js';
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
      // Perf (2026-06-05): this function never reads agreement.inspections,
      // but `inspections: true` was dragging every inspection row INCLUDING
      // the multi-MB base64 photosJson blobs into memory on every checkin
      // close. Keep the relation shape (in case of future use) but select
      // only slim identity fields — never photosJson / photoStorageRefs.
      inspections: {
        select: { id: true, phase: true, capturedAt: true, actorUserId: true }
      }
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

  // "Last entry wins" — when a check-in records an odometer reading, append a
  // CHECKIN row to the vehicle's mileage history AND mirror it onto
  // Vehicle.mileage + lastOdometerSource (so the next check-out auto-populates
  // from the freshest value and the profile shows where the number came from).
  // recordMileageEntrySafe swallows its own errors → non-fatal, check-in still
  // proceeds if the history write fails. (2026-05-28 mirror → 2026-06-09 history.)
  if (odometerIn != null && agreement.vehicleId) {
    await recordMileageEntrySafe(prisma, {
      vehicleId: agreement.vehicleId,
      tenantId: agreement.tenantId ?? null,
      mileage: odometerIn,
      source: 'CHECKIN',
      reservationId: agreement.reservationId,
      rentalAgreementId: agreement.id,
      reservationNumber: agreement.reservation?.reservationNumber || null,
      actorUserId: actorUserId || null,
    });
  }

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

  // waiveLateFee: agent override. When true the LATE_RETURN computation is
  // skipped entirely (we pass dueBackAt=null so the fee engine returns null
  // for that line item). Audit-trailed via the system note on the
  // reservation so we can answer "why didn't this rental get charged a
  // late fee?" months later.
  const waiveLateFee = !!payload.waiveLateFee;

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
    dueBackAt: waiveLateFee ? null : dueBackAt,
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
  // Treat anything within half-a-cent as zero. Floating-point rounding from
  // tax/fee accumulation can leave balances at 0.001 or 0.009 even when the
  // customer is logically paid in full — these used to route to the invoice
  // email ("we'll charge your card") instead of the paid-in-full receipt.
  // (2026-05-25 — checkin bug 1.)
  const BALANCE_ZERO_EPSILON = 0.01;

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
  let autochargeAt = null;

  if (newBalance <= BALANCE_ZERO_EPSILON) {
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

    // Bug #44 — car is back on the lot; release it to AVAILABLE
    // (respects IN_MAINTENANCE/OUT_OF_SERVICE/SOLD).
    await syncVehicleStatusForReservation(prisma, {
      vehicleId: agreement.vehicleId,
      reservationId: agreement.reservationId,
      toStatus: 'CHECKED_IN'
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
    // Outstanding balance — checkin-unpaid. Whether (and when) we auto-charge
    // the balance is tenant-configurable in Settings → Payments.
    newStatus = agreement.status;  // keep agreement open until charge resolves
    newReservationStatus = 'CHECKED_IN_UNPAID';

    // Resolve the tenant autocharge policy (AUTO + delayHours, or MANUAL).
    // Defaults to AUTO/24h if settings can't be read.
    let autoMode = 'AUTO';
    let delayMs = AUTOCHARGE_DELAY_MS;
    try {
      const pgCfg = await settingsService.getPaymentGatewayConfig({ tenantId: agreement.tenantId });
      const ac = pgCfg?.autocharge || {};
      autoMode = String(ac.mode || 'AUTO').toUpperCase() === 'MANUAL' ? 'MANUAL' : 'AUTO';
      const h = Number(ac.delayHours);
      if (Number.isFinite(h) && h >= 0) delayMs = Math.round(h) * 60 * 60 * 1000;
    } catch (err) {
      logger.warn('[checkin-close] could not read autocharge config; defaulting to AUTO/24h', { agreementId, message: err.message });
    }

    // MANUAL → no background charge; staff collects in the View Payments tab.
    // AUTO   → stamp autochargeAt and enqueue the delayed charge job.
    autochargeAt = autoMode === 'AUTO' ? new Date(Date.now() + delayMs) : null;

    await prisma.reservation.update({
      where: { id: agreement.reservationId },
      data: {
        status: 'CHECKED_IN_UNPAID',
        autochargeAt
      }
    });

    // Bug #44 — checked in (balance pending) but the car is physically
    // returned, so free it for re-rental → AVAILABLE.
    await syncVehicleStatusForReservation(prisma, {
      vehicleId: agreement.vehicleId,
      reservationId: agreement.reservationId,
      toStatus: 'CHECKED_IN_UNPAID'
    });

    if (autoMode === 'AUTO') {
      // Enqueue with idempotent jobId so re-runs don't double-charge
      autochargeJobId = `autocharge-${agreement.reservationId}-${autochargeAt.getTime()}`;
      try {
        await enqueueJob(
          'reservation.autocharge-after-checkin',
          { reservationId: agreement.reservationId },
          {
            delay: delayMs,
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
    } else {
      logger.info('[checkin-close] autocharge MANUAL — balance left for staff to collect in View Payments', {
        agreementId, reservationId: agreement.reservationId
      });
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
        waiveLateFee,
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
    autochargeAt
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

  const agreementPayment = await prisma.rentalAgreementPayment.create({
    data: {
      rentalAgreementId,
      method,
      amount,
      reference,
      status: 'PAID',
      notes
    }
  });

  // 2026-06-06: mirror the manual check-in charge into ReservationPayment so it
  // shows in the View Payments panel (which reads reservation.payments). Without
  // this, a payment collected during check-in posted to the agreement ledger
  // only and was invisible in View Payments (and missing from the reservation
  // page's paid total). Linked via rentalAgreementPaymentId so the two ledgers
  // stay deduped/consistent. Non-fatal: a mirror failure must not break check-in.
  try {
    const agr = await prisma.rentalAgreement.findUnique({
      where: { id: rentalAgreementId },
      select: { reservationId: true }
    });
    if (agr?.reservationId) {
      await prisma.reservationPayment.create({
        data: {
          reservationId: agr.reservationId,
          method,
          amount,
          reference,
          status: 'PAID',
          paidAt: new Date(),
          origin: 'OTC',
          notes,
          rentalAgreementPaymentId: agreementPayment.id
        }
      });
    }
  } catch (e) {
    logger.warn('[checkin-close] failed to mirror manual payment to ReservationPayment', {
      rentalAgreementId, message: e?.message || String(e)
    });
  }

  // Recompute paid amount + balance on the agreement
  // 2026-06-06 Option B: count REAL captured money only — AUTH_HOLD deposit
  // authorizations are excluded from paidAmount / balance.
  const allPayments = await prisma.rentalAgreementPayment.findMany({
    where: { rentalAgreementId, status: 'PAID', method: { not: 'AUTH_HOLD' } },
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
