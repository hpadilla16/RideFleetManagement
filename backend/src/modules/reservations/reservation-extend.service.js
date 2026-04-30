import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';

// =============================================================================
// Reservation Extension Service
// =============================================================================
//
// Unified extend + addendum flow (Bug 6, 2026-04-30). One operation:
//
//   1. Snapshot all current selected charges (originalCharges).
//   2. Set Reservation.originalReturnAt the FIRST time we extend (so the
//      UI can render "Originally returned X · Now returns Y"). Subsequent
//      extensions leave it alone.
//   3. Create the EXTENSION_RATE charge with taxable=true (yes, Hector —
//      the extension rate IS taxed; the previous taxable=false was a
//      bug carried over from the v1 stub).
//   4. Rescale chargeType=DAILY rows that aren't EXTENSION_RATE itself,
//      a tax row, or a security deposit, so quantity = newTotalDays and
//      total = quantity × rate. FIXED and PERCENT charges are NOT
//      touched (per Hector: percentage rows naturally re-evaluate
//      against the new subtotal at display time, fixed fees are
//      one-time).
//   5. Recompute the TAX row from the NEW taxable subtotal (which now
//      includes the extension rate and the rescaled DAILY items).
//   6. Update Reservation.returnAt + estimatedTotal.
//   7. Auto-create a RentalAgreementAddendum with:
//        reasonCategory='EXTENSION', extensionChargeId=<the new charge>,
//        originalCharges/newCharges/chargeDelta JSON snapshots,
//        pickupAt = the OLD returnAt (start of extension period),
//        returnAt = the NEW returnAt,
//        signatureToken (24-byte, 14-day TTL, same shape as manual
//          addendum so the existing /api/public/addendum-signature/:token
//          flow Just Works).
//
// Each extension creates its own addendum — multi-extension is allowed
// and produces a chain of independently-signable/voidable addendums.
//
// deleteExtension(reservationId, extensionChargeId) reverts an extension
// IF its addendum is still PENDING_SIGNATURE. Once SIGNED we refuse —
// signed contract is a legal record; the agent must void the addendum
// first (existing voidAddendum) before deleting.
// =============================================================================

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function scopedReservationWhere(id, scope = {}) {
  return { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) };
}

function rentalDays(pickupAt, returnAt) {
  const start = new Date(pickupAt || Date.now());
  const end = new Date(returnAt || Date.now());
  const diff = end.getTime() - start.getTime();
  return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)) || 1);
}

function isSecurityDepositCharge(row = {}) {
  const source = String(row?.source || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return source === 'SECURITY_DEPOSIT' || name === 'SECURITY DEPOSIT';
}

function isExtensionCharge(row = {}) {
  return String(row?.code || '').trim().toUpperCase() === 'EXTENSION_RATE';
}

function isTaxCharge(row = {}) {
  return String(row?.chargeType || '').trim().toUpperCase() === 'TAX';
}

// Sources whose ReservationCharge rows are provisioned per-day by the
// booking engine (chargeType=UNIT, quantity=days, rate=dailyRate — see
// booking-engine.service.js:1822). When the rental window grows, these
// must rescale alongside chargeType=DAILY rows.
const PER_DAY_LIKE_SOURCES = new Set([
  'SERVICE',
  'ADDITIONAL_SERVICE',
  'FEE',
  'SERVICE_LINKED_FEE'
]);

// Returns true if this row is a per-day charge whose quantity should
// follow the reservation's total day count. EXTENSION_RATE has its own
// fixed extension-window quantity and stays put. Security deposit and
// tax rows are not consumption-based, so they don't rescale either.
//
// Detection paths:
//   1. chargeType=DAILY — direct per-day charge (the original BASE_RATE).
//   2. chargeType=UNIT with a per-day-like source AND quantity equal to
//      the pre-extension day count — the booking engine stores per-day
//      services this way (Pre-Paid Tolls, etc.). Matching quantity is
//      the strongest signal that the row was provisioned as
//      `quantity = days × rate = dailyRate`. Rows whose quantity has
//      been manually overridden (e.g., agent set 1 unit instead of N
//      days) are left alone — heuristic fails safely.
function shouldRescaleDailyRow(row = {}, oldTotalDays = 0) {
  if (isExtensionCharge(row)) return false;
  if (isTaxCharge(row)) return false;
  if (isSecurityDepositCharge(row)) return false;
  const chargeType = String(row?.chargeType || '').trim().toUpperCase();
  if (chargeType === 'DAILY') return true;
  if (chargeType === 'UNIT') {
    const source = String(row?.source || '').trim().toUpperCase();
    if (PER_DAY_LIKE_SOURCES.has(source)) {
      const qty = Number(row?.quantity);
      if (Number.isFinite(qty) && Number.isFinite(oldTotalDays) && qty === Number(oldTotalDays)) {
        return true;
      }
    }
  }
  return false;
}

function snapshotCharge(row = {}) {
  // Trim a charge to just the fields we need to capture in addendum
  // JSON. Decimal columns come back as strings or Decimal objects —
  // normalize to strings so JSON round-trips cleanly.
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    chargeType: row.chargeType,
    quantity: String(row.quantity ?? ''),
    rate: String(row.rate ?? ''),
    total: String(row.total ?? ''),
    taxable: !!row.taxable,
    selected: row.selected !== false,
    sortOrder: row.sortOrder ?? 0,
    source: row.source ?? null,
    sourceRefId: row.sourceRefId ?? null
  };
}

function summarizeChargeTotals(charges = []) {
  const rows = Array.isArray(charges) ? charges : [];
  const subtotal = Number(rows
    .filter((r) => !isTaxCharge(r) && !isSecurityDepositCharge(r))
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const taxes = Number(rows
    .filter((r) => isTaxCharge(r))
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const total = Number((subtotal + taxes).toFixed(2));
  return { subtotal, taxes, total };
}

function buildExtensionChargeData({
  reservationId,
  extensionDays,
  extensionDailyRate,
  currentDailyRate,
  sortOrder
}) {
  if (extensionDays <= 0) {
    throw new Error('Extension days must be > 0');
  }
  const overrideProvided = extensionDailyRate !== null && extensionDailyRate !== undefined;
  const rateToUse = overrideProvided ? toNumber(extensionDailyRate) : toNumber(currentDailyRate, 0);
  const total = Number((extensionDays * rateToUse).toFixed(2));

  return {
    reservationId,
    code: 'EXTENSION_RATE',
    name: `Extension (${extensionDays} day${extensionDays !== 1 ? 's' : ''} @ $${rateToUse.toFixed(2)}/day)`,
    chargeType: 'DAILY',
    quantity: extensionDays,
    rate: rateToUse,
    total,
    // Hector 2026-04-30: extension rate IS taxable. The TAX row is
    // recomputed in step 5 of extendReservation against the new
    // taxable subtotal (which now includes this row).
    taxable: true,
    selected: true,
    source: overrideProvided ? 'EXTENSION_OVERRIDE' : 'EXTENSION_DEFAULT',
    sourceRefId: null,
    sortOrder,
    notes: null
  };
}

// Recompute the TAX row(s) for a reservation after charges have changed.
// Mirrors the canonical pattern in customer-portal.routes.js: blow away
// old TAX rows, compute a single new tax line from the taxable subtotal
// using pricingSnapshot.taxRate (falling back to pickup location's
// taxRate). Returns the resulting TAX charge row, or null if there's no
// tax to apply (no taxable charges, or no tax rate available).
async function recomputeTaxRow({ reservationId, pricingSnapshot, pickupLocationId }) {
  const remaining = await prisma.reservationCharge.findMany({
    where: { reservationId, selected: true }
  });

  await prisma.reservationCharge.deleteMany({
    where: { reservationId, chargeType: 'TAX' }
  });

  const taxableTotal = remaining
    .filter((c) => !isTaxCharge(c) && !!c.taxable)
    .reduce((sum, c) => sum + toNumber(c.total), 0);

  if (taxableTotal <= 0) return null;

  let taxRate = toNumber(pricingSnapshot?.taxRate);
  if (!taxRate && pickupLocationId) {
    const loc = await prisma.location.findUnique({
      where: { id: pickupLocationId },
      select: { taxRate: true }
    });
    taxRate = toNumber(loc?.taxRate);
  }
  if (taxRate <= 0) return null;

  const taxAmount = Number((taxableTotal * taxRate / 100).toFixed(2));
  return prisma.reservationCharge.create({
    data: {
      reservationId,
      source: 'TAX_RECALC',
      name: `Sales Tax (${taxRate.toFixed(2)}%)`,
      chargeType: 'TAX',
      quantity: 1,
      rate: taxAmount,
      total: taxAmount,
      taxable: false,
      selected: true,
      sortOrder: 999
    }
  });
}

async function getReservationOrThrow(reservationId, scope = {}) {
  const row = await prisma.reservation.findFirst({
    where: scopedReservationWhere(reservationId, scope),
    include: {
      pricingSnapshot: true,
      rentalAgreement: { select: { id: true, status: true, tenantId: true } },
      charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
    }
  });
  if (!row) throw new Error('Reservation not found');
  return row;
}

export const reservationExtendService = {
  async extendReservation({
    reservationId,
    newReturnAt,
    extensionDailyRate,
    note,
    actorUserId,
    actorRole,
    tenantScope
  }) {
    // 1. Validate inputs
    if (!newReturnAt) {
      throw new Error('New return date is required');
    }
    const nextReturnDate = new Date(newReturnAt);
    if (Number.isNaN(nextReturnDate.getTime())) {
      throw new Error('newReturnAt is invalid');
    }

    // 2. Load reservation (with agreement + charges)
    const current = await getReservationOrThrow(reservationId, tenantScope);

    const currentReturnDate = new Date(current.returnAt);
    if (nextReturnDate <= currentReturnDate) {
      throw new Error('New return date must be after the current return date');
    }

    const reservationStatus = String(current.status || '').toUpperCase();
    const disallowedStates = ['CANCELLED', 'CHECKED_IN'];
    if (disallowedStates.includes(reservationStatus)) {
      throw new Error(`Cannot extend a reservation with status ${current.status}`);
    }

    // 3. Validate extensionDailyRate (Codex bot finding from PR #30:
    //    toNumber('abc') silently returns 0. Use Number() + finite check
    //    so we reject malformed payloads instead of treating them as
    //    free extensions.)
    let validatedExtensionDailyRate = null;
    if (extensionDailyRate !== null && extensionDailyRate !== undefined && extensionDailyRate !== '') {
      const rate = Number(extensionDailyRate);
      if (!Number.isFinite(rate)) {
        throw new Error('extensionDailyRate must be a valid number');
      }
      if (rate < 0) {
        throw new Error('extensionDailyRate cannot be negative');
      }
      validatedExtensionDailyRate = rate;
    }

    // 4. Snapshot pre-extension charges for the addendum's audit trail
    const originalChargesSnapshot = (current.charges || []).map(snapshotCharge);

    // 5. Compute extension days + old/new total days (for rescale)
    const extensionDays = rentalDays(current.returnAt, nextReturnDate);
    const newTotalDays = rentalDays(current.pickupAt, nextReturnDate);
    const oldTotalDays = rentalDays(current.pickupAt, current.returnAt);

    // 6. Set originalReturnAt on FIRST extension only. Use the
    //    persisted column as source of truth so we never overwrite it
    //    on extensions 2..N.
    const originalReturnAtForFirstExt = current.originalReturnAt
      ? null
      : currentReturnDate;

    // 7. Update Reservation.returnAt (and originalReturnAt if first ext)
    await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        returnAt: nextReturnDate,
        ...(originalReturnAtForFirstExt
          ? { originalReturnAt: originalReturnAtForFirstExt }
          : {})
      }
    });

    // 8. Rescale per-day items: chargeType=DAILY plus per-day SERVICE/
    //    FEE rows (UNIT chargeType, qty == oldTotalDays) get bumped to
    //    the new total days. EXTENSION_RATE / TAX / security deposit
    //    are skipped (see shouldRescaleDailyRow above).
    for (const row of current.charges || []) {
      if (!shouldRescaleDailyRow(row, oldTotalDays)) continue;
      const newQuantity = newTotalDays;
      const newTotal = Number((newQuantity * toNumber(row.rate)).toFixed(2));
      await prisma.reservationCharge.update({
        where: { id: row.id },
        data: { quantity: newQuantity, total: newTotal }
      });
    }

    // 9. Create the new EXTENSION_RATE charge (always taxable=true)
    const maxSortOrder = (current.charges || [])
      .reduce((m, r) => Math.max(m, Number.isInteger(r.sortOrder) ? r.sortOrder : 0), 0);
    const extensionChargeData = buildExtensionChargeData({
      reservationId,
      extensionDays,
      extensionDailyRate: validatedExtensionDailyRate,
      currentDailyRate: toNumber(current.pricingSnapshot?.dailyRate, toNumber(current.dailyRate)),
      sortOrder: maxSortOrder + 1
    });
    const extensionCharge = await prisma.reservationCharge.create({
      data: extensionChargeData
    });

    // 10. Recompute TAX row from the new taxable subtotal (which now
    //     includes the extension rate + the rescaled DAILY items).
    await recomputeTaxRow({
      reservationId,
      pricingSnapshot: current.pricingSnapshot,
      pickupLocationId: current.pickupLocationId
    });

    // 11. Recompute estimatedTotal across all selected charges
    const finalCharges = await prisma.reservationCharge.findMany({
      where: { reservationId, selected: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    const newChargesSnapshot = finalCharges.map(snapshotCharge);
    const { total: newEstimatedTotal } = summarizeChargeTotals(finalCharges);
    await prisma.reservation.update({
      where: { id: reservationId },
      data: { estimatedTotal: newEstimatedTotal }
    });

    // 12. Auto-create RentalAgreementAddendum (only if the reservation
    //     has an agreement — extending a pre-checkout reservation skips
    //     the addendum since there's nothing signed to amend yet).
    let addendum = null;
    if (current.rentalAgreement?.id) {
      const chargeDelta = {
        previousReturnAt: currentReturnDate.toISOString(),
        newReturnAt: nextReturnDate.toISOString(),
        extensionDays,
        extensionChargeId: extensionCharge.id,
        extensionDailyRate: toNumber(extensionChargeData.rate),
        extensionTotal: toNumber(extensionChargeData.total),
        previousEstimatedTotal: toNumber(current.estimatedTotal),
        newEstimatedTotal,
        rescaledDailyChargeIds: (current.charges || [])
          // Codex bot P2 on PR #36: passing shouldRescaleDailyRow bare to
          // .filter makes Array.filter pass (item, index, array), so
          // index would be treated as oldTotalDays. Wrap to thread the
          // real oldTotalDays through — otherwise this metadata silently
          // misses per-day UNIT rows for Bug 7a scenarios.
          .filter((r) => shouldRescaleDailyRow(r, oldTotalDays))
          .map((r) => r.id)
      };

      // Same 24-byte / 14-day TTL signature token as the manual
      // createAddendum flow in rental-agreements.service.js, so the
      // existing /api/public/addendum-signature/:token consumer Just
      // Works for these auto-created ones too.
      const signatureToken = crypto.randomBytes(24).toString('base64url');
      const signatureTokenExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      addendum = await prisma.rentalAgreementAddendum.create({
        data: {
          rentalAgreementId: current.rentalAgreement.id,
          tenantId: current.tenantId || current.rentalAgreement.tenantId || tenantScope?.tenantId || null,
          // pickupAt = start of extension period (the OLD returnAt),
          // returnAt = new returnAt. This lets deleteExtension recover
          // the previous returnAt directly from the addendum row.
          pickupAt: currentReturnDate,
          returnAt: nextReturnDate,
          reason: String(note || '').trim() || `Reservation extended to ${nextReturnDate.toISOString()}`,
          reasonCategory: 'EXTENSION',
          initiatedBy: actorUserId || null,
          // Mirror manual createAddendum's pattern (rental-agreements.service.js):
          // capture the actor's actual role for an accurate audit trail. Sentry
          // bot finding on PR #34 — was hardcoded 'ADMIN' which broke audit
          // accuracy when an AGENT or OPS user did the extension.
          initiatedByRole: String(actorRole || 'ADMIN').trim().toUpperCase(),
          status: 'PENDING_SIGNATURE',
          signatureToken,
          signatureTokenExpiresAt,
          originalCharges: JSON.stringify(originalChargesSnapshot),
          newCharges: JSON.stringify(newChargesSnapshot),
          chargeDelta: JSON.stringify(chargeDelta),
          extensionChargeId: extensionCharge.id
        }
      });
    }

    // 13. Audit log
    await prisma.auditLog.create({
      data: {
        tenantId: current.tenantId || tenantScope?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: actorUserId || null,
        metadata: JSON.stringify({
          reservationExtended: true,
          previousReturnAt: current.returnAt,
          nextReturnAt: nextReturnDate,
          extensionDays,
          newTotalDays,
          extensionDailyRate: validatedExtensionDailyRate,
          extensionChargeId: extensionCharge.id,
          addendumId: addendum?.id || null,
          firstExtensionForReservation: !!originalReturnAtForFirstExt,
          note: String(note || '').trim() || null
        })
      }
    });

    // 14. Return updated reservation snapshot
    const final = await prisma.reservation.findFirst({
      where: { id: reservationId },
      include: {
        pricingSnapshot: true,
        charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      }
    });

    return {
      reservation: final,
      extensionCharge,
      extensionDays,
      newTotalDays,
      addendum
    };
  },

  // ---------------------------------------------------------------------------
  // deleteExtension: revert a single extension cleanly. Only the LATEST
  // extension can be removed (LIFO) — if the agent needs to undo an older
  // one, they delete extensions in reverse order to keep state consistent.
  //
  // Refuses if the linked addendum is SIGNED. Signed contracts are legal
  // records; the agent must voidAddendum() (existing) first.
  // ---------------------------------------------------------------------------
  async deleteExtension({ reservationId, extensionChargeId, actorUserId, tenantScope }) {
    if (!reservationId) throw new Error('reservationId is required');
    if (!extensionChargeId) throw new Error('extensionChargeId is required');

    const reservation = await getReservationOrThrow(reservationId, tenantScope);

    const extensionCharge = (reservation.charges || []).find(
      (c) => c.id === extensionChargeId && isExtensionCharge(c)
    );
    if (!extensionCharge) {
      throw new Error('Extension charge not found on this reservation');
    }

    // LIFO ordering: the charge being deleted must be the most-recently
    // created EXTENSION_RATE row. Otherwise we'd leave the chain in a
    // weird state (later extensions referencing days that the deleted
    // one set up).
    //
    // Order by sortOrder DESC (deterministic — extendReservation always
    // assigns ext.sortOrder = max(prior charges) + 1), with createdAt
    // DESC as a defensive tiebreaker for any legacy rows that may share
    // a sortOrder.
    const allExtensions = (reservation.charges || [])
      .filter(isExtensionCharge)
      .sort((a, b) => {
        const so = Number(b.sortOrder ?? 0) - Number(a.sortOrder ?? 0);
        if (so !== 0) return so;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
    if (allExtensions[0]?.id !== extensionChargeId) {
      throw new Error('Only the most recent extension can be deleted. Delete newer extensions first.');
    }

    // Find the linked addendum (if any) and gate on its status.
    const addendum = await prisma.rentalAgreementAddendum.findFirst({
      where: { extensionChargeId }
    });
    if (addendum && String(addendum.status || '').toUpperCase() === 'SIGNED') {
      throw new Error('Cannot delete extension: the addendum has been signed. Void the addendum first.');
    }

    // Recover the previous returnAt from the addendum's pickupAt
    // (we deliberately stored it there). If there's no addendum (extension
    // pre-dates an agreement, edge case), fall back to chained logic:
    //   - if this is the only extension → use originalReturnAt
    //   - else → use the prior extension's createdAt window (best effort
    //     via the audit log; for now we just refuse and ask Hector to
    //     restore via the agreement workflow).
    let previousReturnAt = null;
    if (addendum?.pickupAt) {
      previousReturnAt = new Date(addendum.pickupAt);
    } else if (allExtensions.length === 1 && reservation.originalReturnAt) {
      previousReturnAt = new Date(reservation.originalReturnAt);
    } else {
      throw new Error('Cannot recover previous return date for this extension (no addendum trail).');
    }

    // Revert per-day charges from the addendum's originalCharges
    // snapshot. Each row in the snapshot was captured PRE-extension; we
    // reset its quantity/total to those values. Only rows that were
    // rescale-eligible at extension time get touched — extension rows,
    // tax, security deposit are skipped. Rows that no longer exist
    // (agent deleted an addon between extension and revert) are skipped.
    //
    // Bug 7a: this snapshot now includes rescaled UNIT rows (per-day
    // SERVICE/FEE), not just chargeType=DAILY. Restoring snap.quantity
    // is idempotent for rows that weren't rescaled, so the simplest
    // safe rule is to revert anything that's not extension/tax/deposit.
    if (addendum?.originalCharges) {
      let snapshot = [];
      try { snapshot = JSON.parse(addendum.originalCharges); } catch { snapshot = []; }
      for (const snap of snapshot) {
        if (!snap?.id) continue;
        if (isExtensionCharge(snap)) continue;
        if (isTaxCharge(snap)) continue;
        if (isSecurityDepositCharge(snap)) continue;
        const live = await prisma.reservationCharge.findUnique({ where: { id: snap.id } });
        if (!live) continue;
        await prisma.reservationCharge.update({
          where: { id: snap.id },
          data: {
            quantity: toNumber(snap.quantity, 1),
            total: toNumber(snap.total, 0)
          }
        });
      }
    }

    // Delete the EXTENSION_RATE charge itself.
    await prisma.reservationCharge.delete({ where: { id: extensionChargeId } });

    // Recompute taxes against the now-smaller taxable subtotal.
    await recomputeTaxRow({
      reservationId,
      pricingSnapshot: reservation.pricingSnapshot,
      pickupLocationId: reservation.pickupLocationId
    });

    // Set returnAt back to its pre-extension value. If this was the last
    // remaining extension, ALSO clear originalReturnAt so the UI stops
    // rendering "Originally returned X · Now returns Y".
    const wasLastExtension = allExtensions.length === 1;
    await prisma.reservation.update({
      where: { id: reservationId },
      data: {
        returnAt: previousReturnAt,
        ...(wasLastExtension ? { originalReturnAt: null } : {})
      }
    });

    // Recompute estimatedTotal.
    const finalCharges = await prisma.reservationCharge.findMany({
      where: { reservationId, selected: true }
    });
    const { total: newEstimatedTotal } = summarizeChargeTotals(finalCharges);
    await prisma.reservation.update({
      where: { id: reservationId },
      data: { estimatedTotal: newEstimatedTotal }
    });

    // Void the addendum (if any) — keeps the historical record but
    // marks it as no-longer-applicable.
    if (addendum) {
      await prisma.rentalAgreementAddendum.update({
        where: { id: addendum.id },
        data: { status: 'VOID' }
      });
    }

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId: reservation.tenantId || tenantScope?.tenantId || null,
        reservationId,
        action: 'UPDATE',
        actorUserId: actorUserId || null,
        metadata: JSON.stringify({
          reservationExtensionDeleted: true,
          extensionChargeId,
          revertedReturnAt: previousReturnAt,
          previousReturnAt: reservation.returnAt,
          wasLastExtension,
          addendumId: addendum?.id || null,
          newEstimatedTotal
        })
      }
    });

    const final = await prisma.reservation.findFirst({
      where: { id: reservationId },
      include: {
        pricingSnapshot: true,
        charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      }
    });

    return {
      reservation: final,
      revertedReturnAt: previousReturnAt,
      wasLastExtension,
      voidedAddendumId: addendum?.id || null
    };
  }
};
