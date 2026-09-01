/**
 * Pillar 2 — Checkin close + fee engine orchestration.
 *
 * Sibling to rental-agreements.service.js's closeAgreement(), specifically
 * for the multi-step checkin wizard flow. Unlike the legacy closeAgreement
 * which requires balance=0 before allowing close, this path:
 *
 *   1. Persists checkin inspection values (odo/fuel/cleanliness) AND
 *      returnedAt — the moment the car came back — on the agreement,
 *      before any branch, so a rental that closes owing money still
 *      records the timestamp its late fee was computed from
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
import { validateBackdatedReturn, backdatedReturnNote } from './backdated-return.js';
import { parseDateTimeInTz } from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';
import logger from '../../lib/logger.js';
import { recordMileageEntrySafe } from '../vehicles/mileage-history.service.js';
import { recordFuelReadingSafe } from '../vehicles/fuel-history.service.js';
import { syncVehicleStatusForReservation } from '../vehicles/vehicle-status-sync.js';
import { executeCheckinMaintenanceDecisionSafe } from '../maintenance/maintenance-checkin.service.js';
import { feeEngineService } from '../fees/fee-engine.service.js';
import { settingsService } from '../settings/settings.service.js';
import { sendInvoiceAfterCheckin, sendReceiptPaidInFull } from './checkin-emails.service.js';
import { enqueueJob } from '../../lib/queue/index.js';
import { AUTOCHARGE_PRIORITY } from '../../lib/queue/priorities.js';
import { withTimeout } from '../../lib/with-timeout.js';

// Redis must never hold the check-in close hostage (2026-08-08 incident).
const ENQUEUE_TIMEOUT_MS = Number(process.env.AUTOCHARGE_ENQUEUE_TIMEOUT_MS) || 2000;
import { parseDepositRuleDecision, decideIncludedMilesPerDay, UNLIMITED_MILES } from '../../lib/deposit-rules.js';
import { parseLocationConfig } from '../../lib/location-config.js';

const AUTOCHARGE_DELAY_MS = 24 * 60 * 60 * 1000;  // 24 hours

/**
 * 2026-07-28 (LAX #8) — per-location delay for the post-check-in email
 * (receipt or invoice). locationConfig.checkinEmailDelayHours > 0 defers the
 * send: checkin-close stamps Reservation.checkinEmailDueAt and the
 * checkin-email scheduler delivers later, deciding receipt-vs-invoice from
 * the balance AT SEND TIME (a 24h-autocharge may have settled it meanwhile).
 * 0/absent = today's inline behavior, unchanged.
 */
async function resolveCheckinEmailDelayMs(reservationId) {
  try {
    const row = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { pickupLocation: { select: { locationConfig: true } } },
    });
    const h = Number(parseLocationConfig(row?.pickupLocation?.locationConfig).checkinEmailDelayHours);
    return Number.isFinite(h) && h > 0 ? Math.round(h * 60 * 60 * 1000) : 0;
  } catch {
    return 0;
  }
}

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
  actorIp = null,
  actorRole = 'AGENT'
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
  // Step 0 — Resolve the moment the CAR came back
  // ─────────────────────────────────────────────────────────────────────────

  // LATE_RETURN inputs. Caller can pass `returnedAt` to backdate a checkin;
  // default to now (when the wizard fires). `dueBackAt` is the scheduled
  // return time on the agreement (Step 2). If either is missing the fee
  // engine silently skips the LATE_RETURN computation.
  // Parsed in the TENANT's timezone, not the container's (the extension bug of
  // 2026-08-07: a naive datetime-local read on a UTC clock shifts every typed
  // time by the tenant offset — here that shift would move late-fee money).
  // ISO strings with a Z pass through untouched, so the wizard's default
  // "now" behaves exactly as before.
  const returnedTz = await resolveTenantTimeZone(agreement.tenantId);
  const returnedAt = payload.returnedAt
    ? parseDateTimeInTz(payload.returnedAt, returnedTz)
    : new Date();
  // Who may state "the car actually came back earlier", and how far. The
  // plumbing for payload.returnedAt always existed — ungated. Exposing it in
  // the UI without this check would make erasing late fees invisible.
  // Validated BEFORE the first write: a backdate the actor is not allowed
  // to make must not leave the odometer/fuel readings behind on a close
  // that then 403s.
  const backdateCheck = validateBackdatedReturn({
    returnedAt,
    role: actorRole,
    rentalStartAt: agreement.finalizedAt || agreement.pickupAt || null,
  });
  if (!backdateCheck.ok) {
    const err = new Error(backdateCheck.error);
    err.status = 403;
    throw err;
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
      cleanlinessIn: cleanlinessIn ?? agreement.cleanlinessIn,
      // The moment the CAR came back — what the contract shows and what
      // the LATE_RETURN fee is computed from. Written HERE, ahead of the
      // balance branch, because it is not the zero-balance path's property:
      // a rental that closes OWING money is exactly the one that just got
      // charged a late fee, and the timestamp justifying that charge has to
      // survive to answer a dispute. (Stamped only on the paid-in-full
      // branch from 2026-08-10 until 2026-08-26.) closedAt stays the
      // operational record: when STAFF closed it.
      returnedAt
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

  // Fuel history (2026-06-29): mirror the CHECKIN odometer entry above for the
  // fuel level captured at check-in, so the vehicle profile shows the fuel
  // out->in timeline paired by reservation. Fail-open — non-fatal if it fails.
  if (fuelIn != null && agreement.vehicleId) {
    await recordFuelReadingSafe(prisma, {
      vehicleId: agreement.vehicleId,
      tenantId: agreement.tenantId ?? null,
      fuelFraction: fuelIn,
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
  const { gallons: tankCapacity, isFallback: tankCapacityIsFallback } = await resolveTankCapacity(agreement);
  const includedMilesPerDay = await resolveIncludedMilesPerDay(agreement);

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
    tankCapacityIsFallback,
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
  const checkinEmailDelayMs = await resolveCheckinEmailDelayMs(agreement.reservationId);
  const checkinEmailDueAt = checkinEmailDelayMs > 0 ? new Date(Date.now() + checkinEmailDelayMs) : null;

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
      data: { status: 'CHECKED_IN', ...(checkinEmailDueAt ? { checkinEmailDueAt, checkinEmailSentAt: null } : {}) }
    });

    // Loaner companion: close the borrower's LoanerAgreement on return so the portal shows
    // returned, reminders stop, and post-return portal requests are rejected. (best-effort)
    await prisma.loanerAgreement.updateMany({
      where: { reservationId: agreement.reservationId, status: { in: ['DRAFT', 'ACTIVE'] } },
      data: { status: 'CLOSED' },
    }).catch(() => {});

    // Bug #44 — car is back on the lot; release it to AVAILABLE
    // (respects IN_MAINTENANCE/OUT_OF_SERVICE/SOLD).
    await syncVehicleStatusForReservation(prisma, {
      vehicleId: agreement.vehicleId,
      reservationId: agreement.reservationId,
      toStatus: 'CHECKED_IN'
    });

    // 0-balance receipt — inline unless the location defers it (LAX #8).
    if (checkinEmailDueAt) {
      logger.info('[checkin-close] receipt email deferred by location config', {
        agreementId, dueAt: checkinEmailDueAt.toISOString()
      });
    } else {
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
        autochargeAt,
        ...(checkinEmailDueAt ? { checkinEmailDueAt, checkinEmailSentAt: null } : {})
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
        // Bounded, because the catch below cannot save us from a HANG. This
        // enqueue talks to the same managed Redis whose maintenance stalled
        // every request on 2026-08-08; unbounded, it would hang the CHECK-IN
        // CLOSE itself and the customer would watch their return fail. The
        // autocharge only accelerates: on timeout the balance drops into the
        // manual workflow, which is exactly what the catch already does.
        await withTimeout(
          enqueueJob(
            'reservation.autocharge-after-checkin',
            { reservationId: agreement.reservationId },
            {
              delay: delayMs,
              jobId: autochargeJobId,
              priority: AUTOCHARGE_PRIORITY
            }
          ),
          ENQUEUE_TIMEOUT_MS,
          'autocharge enqueue'
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

    // Invoice email with card-on-file notice — inline unless deferred (LAX #8).
    if (checkinEmailDueAt) {
      logger.info('[checkin-close] invoice email deferred by location config', {
        agreementId, dueAt: checkinEmailDueAt.toISOString()
      });
    } else {
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
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Step 6b — Maintenance detection at check-in (Feature A, 2026-09-01)
  // ─────────────────────────────────────────────────────────────────────────
  // The Step-3 decision was ARMED in the wizard and FIRES here — deliberately
  // AFTER both balance branches' syncVehicleStatusForReservation calls above:
  // the sync sets the returned car AVAILABLE, which is exactly the state the
  // RO-open transition (setVehicleInMaintenance) can flip to the locked
  // IN_MAINTENANCE. Fail-open by contract: the executor never throws, so a
  // failed RO-open cannot block the check-in that already settled the money —
  // the wizard surfaces "couldn't move to maintenance — open manually" from
  // the FAILED outcome, with a retry that hits the maintenance router.
  let maintenance = null;
  if (payload.maintenanceDecision && agreement.vehicleId) {
    maintenance = await executeCheckinMaintenanceDecisionSafe({
      tenantId: agreement.tenantId,
      vehicleId: agreement.vehicleId,
      reservationId: agreement.reservationId,
      rentalAgreementId: agreement.id,
      reservationNumber: agreement.reservation?.reservationNumber || null,
      locationId: agreement.returnLocationId || agreement.pickupLocationId || null,
      action: payload.maintenanceDecision.action,
      serviceTypes: payload.maintenanceDecision.serviceTypes,
      note: payload.maintenanceDecision.note,
      odometer: odometerIn ?? agreement.odometerIn,
      actorUserId: actorUserId || null,
    });
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
        // The backdated close leaves its trail HERE, in the audit that every
        // close already writes — "why didn't this rental get a late fee?" has
        // one place to look (Hector, 2026-08-10).
        ...(backdateCheck.backdated ? {
          backdatedCheckIn: true,
          actualReturnAt: returnedAt.toISOString(),
          recordedBy: String(actorRole || 'UNKNOWN').toUpperCase(),
          note: backdatedReturnNote({ returnedAt, actorRole }),
        } : {}),
        newBalance,
        autochargeJobId,
        waiveLateFee,
        // Feature A: the maintenance decision outcome rides the same audit
        // row every close already writes (SENT/SNOOZED/FAILED + RO id).
        ...(maintenance ? {
          maintenanceDecision: String(payload.maintenanceDecision?.action || '').toUpperCase(),
          maintenanceOutcome: maintenance.status,
          maintenanceRepairOrderId: maintenance.repairOrderId || null,
        } : {}),
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
    autochargeAt,
    // Feature A outcome for the wizard's success step: SENT (hand-off strip
    // naming the RO), SNOOZED, or FAILED (retry link). Null = no decision.
    maintenance
  };
}

// =============================================================================
// Helpers
// =============================================================================

export function computeRentalDays(pickupAt, returnAt) {
  if (!pickupAt || !returnAt) return 1;
  const p = new Date(pickupAt).getTime();
  const r = new Date(returnAt).getTime();
  const ms = Math.max(0, r - p);
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  return Math.max(1, days);
}

export async function resolveTankCapacity(agreement) {
  // 2026-06-10 (#51): this used to select Vehicle columns that never existed
  // (tankCapacityGallons/fuelTankSize) — Prisma threw, the .catch swallowed
  // it, and EVERY vehicle billed fuel as a 15-gal tank. It now reads the real
  // fuelTankCapacityGallons column (additive migration 20260610) and only
  // falls back to 15 (with a visible warn + a note on the fee line) when the
  // vehicle has no capacity configured.
  const vehicleId = agreement.vehicleId;
  if (!vehicleId) return { gallons: 15, isFallback: true };
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { fuelTankCapacityGallons: true, internalNumber: true }
  }).catch(() => null);
  const cap = Number(vehicle?.fuelTankCapacityGallons || 0);
  if (cap > 0) return { gallons: cap, isFallback: false };
  logger.warn('[checkin-close] vehicle has no fuelTankCapacityGallons — billing fuel against 15 gal fallback', {
    vehicleId,
    internalNumber: vehicle?.internalNumber || null,
    rentalAgreementId: agreement.id
  });
  return { gallons: 15, isFallback: true };
}

export async function resolveIncludedMilesPerDay(agreement) {
  // 2026-07-25 — no longer a hardcoded 200 stub. Resolution order:
  //  1. The frozen local/non-local rule decision on the reservation's
  //     pricing snapshot (LAX: 150 mi/day for a local renter, unlimited for
  //     non-local). This is the SAME decision the deposit was based on, so
  //     the miles the contract promised are the miles billing honors.
  //  2. The vehicle type's own mileage profile (unlimitedMileage /
  //     freeMilesPerDay) — before this change those fields were shown on
  //     the public site but IGNORED at check-in billing, so an
  //     unlimited-mileage class still billed overage past 200 mi/day.
  //  3. The legacy 200 mi/day fallback, unchanged.
  // Unlimited is returned as Infinity: computeExcessMileage's arithmetic
  // (driven − Infinity < 0 → excess 0) makes it a safe no-fee sentinel.
  // Any lookup failure falls back to 200 — a broken read must degrade to
  // the historical behavior, not throw inside check-in close.
  try {
    if (agreement?.reservationId) {
      const snapshot = await prisma.reservationPricingSnapshot.findUnique({
        where: { reservationId: agreement.reservationId },
        select: { securityDepositRuleJson: true }
      }).catch(() => null);
      const decision = parseDepositRuleDecision(snapshot?.securityDepositRuleJson);
      const fromRule = decideIncludedMilesPerDay({ decision });
      if (fromRule != null) return fromRule;
    }
    if (agreement?.vehicleId) {
      const vehicle = await prisma.vehicle.findUnique({
        where: { id: agreement.vehicleId },
        select: { vehicleType: { select: { unlimitedMileage: true, freeMilesPerDay: true } } }
      }).catch(() => null);
      const vehicleType = vehicle?.vehicleType;
      if (vehicleType?.unlimitedMileage) return UNLIMITED_MILES;
      const freeMiles = Number(vehicleType?.freeMilesPerDay || 0);
      if (Number.isFinite(freeMiles) && freeMiles > 0) return freeMiles;
    }
  } catch (err) {
    logger.warn('[checkin-close] resolveIncludedMilesPerDay lookup failed — using 200 mi/day fallback', {
      rentalAgreementId: agreement?.id || null,
      err: String(err?.message || err)
    });
  }
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
    // 2026-06-10: reservationId added for the audit-log write below.
    // AuditLog.reservationId is REQUIRED in the schema, so the old
    // `reservationId: null` create always threw — and the `.catch(() => {})`
    // swallowed it, so manual check-in payments never produced an audit row.
    select: { total: true, reservationId: true }
  });
  const newBalance = Math.max(0, Number((Number(agreement.total || 0) - totalPaid).toFixed(2)));

  await prisma.rentalAgreement.update({
    where: { id: rentalAgreementId },
    data: {
      paidAmount: Number(totalPaid.toFixed(2)),
      balance: newBalance
    }
  });

  if (actorUserId && agreement?.reservationId) {
    await prisma.auditLog.create({
      data: {
        reservationId: agreement.reservationId,
        actorUserId,
        action: 'UPDATE',
        reason: `Manual payment applied via checkin wizard: ${method} $${amount.toFixed(2)}${reference ? ` (${reference})` : ''}`,
        metadata: JSON.stringify({ rentalAgreementId, amount, method, reference, receiptUrl: payment.receiptUrl || null })
      }
    }).catch((e) => {
      // Audit is best-effort (must never break the payment), but DON'T be
      // silent about it — silence is exactly how this bug went unnoticed.
      logger.warn('[checkin-close] manual-payment audit log failed', {
        rentalAgreementId, message: e?.message || String(e)
      });
    });
  }

  return { totalPaid, newBalance };
}

export const checkinCloseService = {
  closeAgreementWithCheckinFees
};
