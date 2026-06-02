/**
 * SUPER_ADMIN reservation status override routes (round 26 — 2026-06-01,
 * adapted to release/v0.9.0-beta.58 schema on 2026-06-02).
 *
 * NOTE ON THIS ADAPTATION
 *   The original route (commit 7dce549) was authored on feature/incident-report,
 *   which carries a newer schema than this release branch. The following models
 *   / fields it referenced do NOT exist here, so this version drops them:
 *     - ReservationSigning / ReservationSigningField models  → signatures on this
 *       branch live as Reservation.signature* fields, which we clear directly.
 *     - DejavooTransaction model → no row-level Dejavoo tracking on this branch,
 *       so paymentsForManualRefund is always []. The frontend panel renders the
 *       refund table only when the list is non-empty, so it degrades cleanly.
 *     - Reservation.rentalFeeCollectedAt / rentalFeeCollectedCents /
 *       signingCompletedAt → not present here; removed from the field-clear list.
 *   Everything else (status set, rewind detection, orphan RentalAgreement delete,
 *   vehicle-status sync, AuditLog) maps 1:1 to this branch's schema.
 *
 * Mounted in main.js as:
 *   app.use('/api/admin/reservations', requireAuth, requireRole('SUPER_ADMIN'),
 *           reservationOverrideRouter);
 *
 * Final paths:
 *   GET    /api/admin/reservations/:id/override-preview?toStatus=CONFIRMED
 *     Preview what a status override would do (does NOT mutate).
 *     Returns { fromStatus, toStatus, isRewind, willDelete: { rentalAgreement },
 *               willClearFields, vehicleSync, paymentsForManualRefund: [] }
 *
 *   PATCH  /api/admin/reservations/:id/status
 *     Body: { toStatus: ReservationStatus, reason: string }
 *     Returns { ok, fromStatus, toStatus, raDeleted, vehicleSync,
 *               paymentsForManualRefund: [], auditLogId }
 *
 * Smart rewind: when going backwards in the lifecycle (e.g. CHECKED_IN -> CONFIRMED)
 * the transaction also:
 *   - syncs Vehicle.status (respects IN_MAINTENANCE / OUT_OF_SERVICE — won't override)
 *   - deletes the orphan RentalAgreement when going pre-checkout
 *   - clears signature timestamps + resets paymentStatus to PENDING
 *   - writes an AuditLog entry (action=ADMIN_OVERRIDE) with reason + metadata
 */

import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import {
  inferVehicleStatusForReservationStatus,
  LOCKED_VEHICLE_STATUSES,
} from '../vehicles/vehicle-status-sync.js';

export const reservationOverrideRouter = Router();

const VALID_STATUSES = [
  'NEW',
  'CONFIRMED',
  'CHECKED_OUT',
  'CHECKED_IN',
  'CHECKED_IN_UNPAID',
  'CANCELLED',
  'NO_SHOW',
  'PENDING_FRANCHISE_IMPORT',
];

// Lifecycle order for rewind detection. Terminal states (CANCELLED/NO_SHOW)
// share level 5 since they're alt branches, not part of the forward flow.
const STATUS_LEVELS = {
  NEW: 0,
  PENDING_FRANCHISE_IMPORT: 0,
  CONFIRMED: 1,
  CHECKED_OUT: 2,
  CHECKED_IN_UNPAID: 3,
  CHECKED_IN: 4,
  CANCELLED: 5,
  NO_SHOW: 5,
};

// Statuses that are "pre-checkout" — rewinding to these drops the agreement
// and clears signature/payment state.
const PRE_CHECKOUT = ['NEW', 'CONFIRMED', 'PENDING_FRANCHISE_IMPORT'];

function isRewind(from, to) {
  if (from === to) return false;
  const fl = STATUS_LEVELS[from] ?? 0;
  const tl = STATUS_LEVELS[to] ?? 0;
  return tl < fl;
}

// inferVehicleStatusForReservationStatus + LOCKED_VEHICLE_STATUSES are imported
// from ../vehicles/vehicle-status-sync.js so the override route and the normal
// checkout/checkin flows share one source of truth (bug #44).

function clearedFieldsForRewind(toStatus) {
  // Only the fields that exist on Reservation in THIS branch.
  if (PRE_CHECKOUT.includes(toStatus)) {
    return [
      'signatureSignedAt',
      'signatureSignedBy',
      'signatureDataUrl',
      'paymentStatus -> PENDING',
    ];
  }
  return [];
}

async function buildPreview(id, toStatus) {
  const before = await prisma.reservation.findUnique({
    where: { id },
    include: {
      rentalAgreement: { select: { id: true, agreementNumber: true, status: true } },
    },
  });
  if (!before) {
    const err = new Error('Reservation not found');
    err.status = 404;
    throw err;
  }
  const fromStatus = before.status;
  const rewind = isRewind(fromStatus, toStatus);

  // Vehicle sync preview
  let vehicleSync = null;
  if (before.vehicleId) {
    const v = await prisma.vehicle.findUnique({
      where: { id: before.vehicleId },
      select: { id: true, internalNumber: true, plate: true, status: true },
    });
    const target = inferVehicleStatusForReservationStatus(toStatus);
    if (v && target) {
      if (LOCKED_VEHICLE_STATUSES.includes(v.status)) {
        vehicleSync = { skipped: true, reason: `vehicle is ${v.status}` };
      } else if (v.status !== target) {
        vehicleSync = { from: v.status, to: target, vehicleId: v.id, internalNumber: v.internalNumber, plate: v.plate };
      } else {
        vehicleSync = { noop: true, status: v.status };
      }
    }
  }

  const willDeleteRA = rewind && PRE_CHECKOUT.includes(toStatus) && !!before.rentalAgreement;

  return {
    fromStatus,
    toStatus,
    isRewind: rewind,
    willDelete: {
      rentalAgreement: willDeleteRA ? before.rentalAgreement : null,
      signing: null, // no ReservationSigning model on this branch
    },
    willClearFields: rewind ? clearedFieldsForRewind(toStatus) : [],
    vehicleSync,
    // No row-level Dejavoo tracking on this branch — nothing to enumerate.
    paymentsForManualRefund: [],
  };
}

reservationOverrideRouter.get('/:id/override-preview', async (req, res) => {
  try {
    const toStatus = String(req.query?.toStatus || '').toUpperCase();
    if (!VALID_STATUSES.includes(toStatus)) {
      return res.status(400).json({ error: `Invalid toStatus. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const preview = await buildPreview(req.params.id, toStatus);
    res.json(preview);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

reservationOverrideRouter.patch('/:id/status', async (req, res) => {
  try {
    const id = req.params.id;
    const toStatus = String(req.body?.toStatus || '').toUpperCase();
    const reason = String(req.body?.reason || '').trim();

    if (!VALID_STATUSES.includes(toStatus)) {
      return res.status(400).json({ error: `Invalid toStatus. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    if (reason.length < 5) {
      return res.status(400).json({ error: 'reason required (min 5 chars) — audit trail mandatory for overrides' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.reservation.findUnique({
        where: { id },
        include: {
          rentalAgreement: { select: { id: true, agreementNumber: true } },
        },
      });
      if (!before) {
        const err = new Error('Reservation not found');
        err.status = 404;
        throw err;
      }

      const fromStatus = before.status;
      if (fromStatus === toStatus) {
        return {
          ok: true,
          noop: true,
          fromStatus,
          toStatus,
          message: 'Status already matches; nothing changed.',
        };
      }

      const rewind = isRewind(fromStatus, toStatus);
      const goingPreCheckout = PRE_CHECKOUT.includes(toStatus);

      let raDeleted = false;
      if (rewind && goingPreCheckout && before.rentalAgreement) {
        // Best-effort: delete any payment links on the agreement first.
        await tx.rentalAgreementPayment
          .deleteMany({ where: { rentalAgreementId: before.rentalAgreement.id } })
          .catch(() => {});
        await tx.rentalAgreement.delete({ where: { id: before.rentalAgreement.id } });
        raDeleted = true;
      }

      const resUpdates = { status: toStatus, updatedAt: new Date() };
      if (rewind && goingPreCheckout) {
        resUpdates.signatureSignedAt = null;
        resUpdates.signatureSignedBy = null;
        resUpdates.signatureDataUrl = null;
        resUpdates.paymentStatus = 'PENDING';
      }
      await tx.reservation.update({ where: { id }, data: resUpdates });

      // Sync vehicle status (respect IN_MAINTENANCE / OUT_OF_SERVICE).
      let vehicleSync = null;
      if (before.vehicleId) {
        const v = await tx.vehicle.findUnique({
          where: { id: before.vehicleId },
          select: { id: true, status: true, internalNumber: true, plate: true },
        });
        const target = inferVehicleStatusForReservationStatus(toStatus);
        if (v && target && v.status !== target && !LOCKED_VEHICLE_STATUSES.includes(v.status)) {
          await tx.vehicle.update({
            where: { id: v.id },
            data: { status: target, updatedAt: new Date() },
          });
          vehicleSync = { from: v.status, to: target, vehicleId: v.id, internalNumber: v.internalNumber, plate: v.plate };
        }
      }

      const audit = await tx.auditLog.create({
        data: {
          tenantId: before.tenantId,
          reservationId: id,
          action: 'ADMIN_OVERRIDE',
          actorUserId: req.user?.id || null,
          fromStatus,
          toStatus,
          reason,
          metadata: JSON.stringify({
            raDeleted,
            vehicleSync,
          }),
        },
        select: { id: true },
      });

      return {
        ok: true,
        fromStatus,
        toStatus,
        raDeleted,
        signingDeleted: false, // no ReservationSigning model on this branch
        vehicleSync,
        paymentsForManualRefund: [],
        auditLogId: audit.id,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('[reservation-override] PATCH failed', err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});
