import { prisma } from '../../lib/prisma.js';
import { tollsService } from '../tolls/tolls.service.js';
import { filterMandatoryFeesForChannel } from '../booking-engine/fee-channel-filter.js';
import { syncVehicleStatusForReservation } from '../vehicles/vehicle-status-sync.js';
import logger from '../../lib/logger.js';

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePaymentMethod(method) {
  const raw = String(method || '').trim().toUpperCase();
  if (!raw) return 'CASH';
  // AUTH_HOLD = security deposit authorization hold. Included for paidAmount
  // math (Option A) so agreement.balance correctly excludes the held amount.
  // The hold is NOT a settled payment — distinguishable downstream via method.
  return ['CASH', 'CARD', 'ZELLE', 'ATH_MOVIL', 'BANK_TRANSFER', 'AUTH_HOLD', 'OTHER'].includes(raw) ? raw : 'OTHER';
}

function normalizePaymentOrigin(origin) {
  const raw = String(origin || '').trim().toUpperCase();
  if (!raw) return 'OTC';
  return ['OTC', 'PORTAL', 'IMPORTED', 'MIGRATED_NOTE'].includes(raw) ? raw : 'OTC';
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

function computeFeeTotal(fee, { baseAmount = 0, days = 1 } = {}) {
  const amount = toNumber(fee?.amount);
  const mode = String(fee?.mode || 'FIXED').trim().toUpperCase();
  if (mode === 'PER_DAY') return Number((amount * days).toFixed(2));
  if (mode === 'PERCENTAGE') return Number((baseAmount * (amount / 100)).toFixed(2));
  return Number(amount.toFixed(2));
}

async function getReservationOrThrow(reservationId, scope = {}) {
  const row = await prisma.reservation.findFirst({
    where: scopedReservationWhere(reservationId, scope),
    include: {
      pricingSnapshot: true,
      charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      payments: { orderBy: { paidAt: 'desc' } },
      rentalAgreement: {
        select: {
          id: true,
          status: true,
          total: true,
          paidAmount: true,
          balance: true
        }
      }
    }
  });
  if (!row) throw new Error('Reservation not found');
  return row;
}

function buildSnapshotUpsertData(payload = {}) {
  return {
    dailyRate: toNullableNumber(payload.dailyRate),
    taxRate: toNullableNumber(payload.taxRate),
    selectedInsuranceCode: payload.selectedInsuranceCode ? String(payload.selectedInsuranceCode).trim() : null,
    selectedInsuranceName: payload.selectedInsuranceName ? String(payload.selectedInsuranceName).trim() : null,
    depositRequired: !!payload.depositRequired,
    depositMode: payload.depositMode ? String(payload.depositMode).trim().toUpperCase() : null,
    depositValue: toNullableNumber(payload.depositValue),
    depositBasisJson: Array.isArray(payload.depositBasis) ? JSON.stringify(payload.depositBasis) : (payload.depositBasisJson ? String(payload.depositBasisJson) : null),
    depositAmountDue: toNumber(payload.depositAmountDue),
    securityDepositRequired: !!payload.securityDepositRequired,
    securityDepositAmount: toNumber(payload.securityDepositAmount),
    source: payload.source ? String(payload.source).trim() : null
  };
}

function buildChargeRows(reservationId, charges = []) {
  return (Array.isArray(charges) ? charges : []).map((row, idx) => ({
    reservationId,
    code: row?.code ? String(row.code).trim() : null,
    name: String(row?.name || `Charge ${idx + 1}`).trim(),
    chargeType: String(row?.chargeType || 'UNIT').trim().toUpperCase(),
    quantity: toNumber(row?.quantity, 1),
    rate: toNumber(row?.rate),
    total: toNumber(
      row?.total,
      toNumber(row?.quantity, 1) * toNumber(row?.rate)
    ),
    taxable: !!row?.taxable,
    selected: row?.selected !== false,
    sortOrder: Number.isInteger(row?.sortOrder) ? row.sortOrder : idx,
    source: row?.source ? String(row.source).trim() : null,
    sourceRefId: row?.sourceRefId ? String(row.sourceRefId).trim() : null,
    notes: row?.notes ? String(row.notes) : null
  }));
}

function isSecurityDepositCharge(row = {}) {
  const source = String(row?.source || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return source === 'SECURITY_DEPOSIT' || name === 'SECURITY DEPOSIT';
}

// 2026-06-06 deposit-balance fix: ALL deposit charges (Deposit Due +
// Security Deposit — both chargeType DEPOSIT) must be EXCLUDED from agreement
// subtotal/total/balance, matching the reservation page's "Unpaid Balance".
// Deposits are held/collected separately; they are not part of the rental
// amount owed. The earlier assumption (below) that an AUTH_HOLD payment would
// offset the deposit in paidAmount did NOT hold in practice — holds are not
// captured as agreement payments — which inflated balance on 100+ agreements.
function isDepositCharge(row = {}) {
  const type = String(row?.chargeType || '').trim().toUpperCase();
  const source = String(row?.source || '').trim().toUpperCase();
  const name = String(row?.name || '').trim().toUpperCase();
  return type === 'DEPOSIT'
    || source === 'DEPOSIT_DUE'
    || source === 'SECURITY_DEPOSIT'
    || name === 'SECURITY DEPOSIT'
    || name === 'DEPOSIT (DUE NOW)';
}

// 2026-06-06 Option B: agreement paidAmount counts REAL captured money only
// (AUTH_HOLD deposit authorizations excluded); balance = max(0, total - paid),
// never negative. Canonical recompute used after payment mutations / re-sync.
async function recomputeAgreementPaidAndBalance(client, agreementId) {
  const agr = await client.rentalAgreement.findUnique({
    where: { id: agreementId },
    select: { total: true }
  });
  if (!agr) return null;
  const rows = await client.rentalAgreementPayment.findMany({
    where: { rentalAgreementId: agreementId, status: 'PAID', method: { not: 'AUTH_HOLD' } },
    select: { amount: true }
  });
  const paidAmount = Number(rows.reduce((s, p) => s + toNumber(p?.amount), 0).toFixed(2));
  const balance = Math.max(0, Number((toNumber(agr.total) - paidAmount).toFixed(2)));
  await client.rentalAgreement.update({
    where: { id: agreementId },
    data: { paidAmount, balance }
  });
  return { paidAmount, balance };
}

function summarizeChargeTotals(charges = []) {
  const rows = Array.isArray(charges) ? charges : [];
  // 2026-06-06: subtotal/total EXCLUDE deposit charges (see isDepositCharge).
  // balance = total - paidAmount is then rental-only and matches the UI.
  // (Superseded the 2026-05-19 "include deposit so AUTH_HOLD offsets it"
  // approach, which left deposits stuck in balance when no hold was captured.)
  const subtotal = Number(rows
    .filter((r) => String(r?.chargeType || '').toUpperCase() !== 'TAX' && !isDepositCharge(r))
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const taxes = Number(rows
    .filter((r) => String(r?.chargeType || '').toUpperCase() === 'TAX')
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const total = Number((subtotal + taxes).toFixed(2));
  return { subtotal, taxes, total };
}

async function syncAgreementCharges(reservationId, scope = {}, opts = {}) {
  const reservation = await prisma.reservation.findFirst({
    where: scopedReservationWhere(reservationId, scope),
    include: {
      charges: { where: { selected: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      rentalAgreement: {
        select: {
          id: true,
          status: true,
          paidAmount: true
        }
      }
    }
  });
  if (!reservation?.rentalAgreement?.id) return null;

  const agreement = reservation.rentalAgreement;
  const agreementStatus = String(agreement.status || '').toUpperCase();
  // 2026-06-08 (post check-in fee fix): routine pricing READS never mutate a
  // closed/cancelled agreement (the original guard). But when a fee is added
  // EXPLICITLY after check-in (issue-center claim, manual "Edit pricing", etc.)
  // the caller passes { allowClosed: true } so the new charge is mirrored into
  // RentalAgreementCharge and the binding total/balance is recomputed.
  // CANCELLED is never reopened. See TL-ZE40787112BA.
  const allowClosed = opts.allowClosed === true;
  if (agreementStatus === 'CANCELLED') return null;
  if (agreementStatus === 'CLOSED' && !allowClosed) return null;

  const chargeRows = (reservation.charges || []).map((row, idx) => ({
    rentalAgreementId: agreement.id,
    code: row.code,
    name: row.name,
    chargeType: row.chargeType,
    quantity: row.quantity,
    rate: row.rate,
    total: row.total,
    taxable: row.taxable,
    selected: row.selected,
    sortOrder: Number.isInteger(row.sortOrder) ? row.sortOrder : idx,
    source: row.source || null,
    sourceRefId: row.sourceRefId || null
  }));

  // BUG-FIX 2026-05-18 (Pillar 2): preserve FEE_ENGINE_* charges from checkin
  // fee posting. The original delete-all + recreate-from-reservation flow
  // wiped fuel/cleaning/smoking/late fees that the fee engine persisted
  // during /checkin-close, because those fees live on the agreement only
  // (no corresponding ReservationCharge row to re-sync from).
  await prisma.rentalAgreementCharge.deleteMany({
    where: {
      rentalAgreementId: agreement.id,
      NOT: { source: { startsWith: 'FEE_ENGINE_' } }
    }
  });
  if (chargeRows.length) {
    await prisma.rentalAgreementCharge.createMany({ data: chargeRows });
  }

  // Recompute totals from the FULL set (reservation-sourced + preserved
  // fee-engine charges) so agreement.total/fees/balance reflect everything.
  const allCharges = await prisma.rentalAgreementCharge.findMany({
    where: { rentalAgreementId: agreement.id, selected: true },
    select: { chargeType: true, total: true, source: true }
  });
  let recSubtotal = 0;
  let recTaxes = 0;
  let recFees = 0;
  for (const c of allCharges) {
    const t = toNumber(c.total);
    const type = String(c.chargeType || '').toUpperCase();
    const src = String(c.source || '').toUpperCase();
    if (type === 'TAX') {
      recTaxes += t;
    } else if (isDepositCharge(c)) {
      // 2026-06-06 deposit-balance fix: deposits are NOT part of the rental
      // total/balance (held/collected separately). Keep the charge row for
      // the record but exclude it from subtotal so balance = total - paid.
      continue;
    } else if (src.startsWith('FEE_ENGINE')) {
      recFees += t;
    } else {
      recSubtotal += t;
    }
  }
  const subtotal = Number(recSubtotal.toFixed(2));
  const taxes = Number(recTaxes.toFixed(2));
  const fees = Number(recFees.toFixed(2));
  const total = Number((subtotal + taxes + fees).toFixed(2));
  // 2026-06-06 Option B: paidAmount = real (non-AUTH_HOLD) payments only, and
  // balance is clamped to >= 0. Deposit holds no longer offset the (now
  // deposit-free) total, so they must be excluded from paidAmount too.
  const paidRows = await prisma.rentalAgreementPayment.findMany({
    where: { rentalAgreementId: agreement.id, status: 'PAID', method: { not: 'AUTH_HOLD' } },
    select: { amount: true }
  });
  const paidAmount = Number(paidRows.reduce((s, p) => s + toNumber(p?.amount), 0).toFixed(2));
  const balance = Math.max(0, Number((total - paidAmount).toFixed(2)));

  await prisma.rentalAgreement.update({
    where: { id: agreement.id },
    data: { subtotal, taxes, fees, total, paidAmount, balance }
  });

  return { agreementId: agreement.id, subtotal, taxes, fees, total, balance };
}

async function maybeCreateAgreementPayment({ reservation, payment }) {
  const agreement = reservation?.rentalAgreement;
  if (!agreement?.id) return null;
  if (['CLOSED', 'CANCELLED'].includes(String(agreement.status || '').toUpperCase())) return null;

  const created = await prisma.rentalAgreementPayment.create({
    data: {
      rentalAgreementId: agreement.id,
      method: payment.method,
      amount: payment.amount,
      reference: payment.reference,
      status: payment.status,
      paidAt: payment.paidAt,
      notes: payment.notes
    }
  });

  // 2026-06-06 Option B: recompute from real payments so an AUTH_HOLD deposit
  // authorization is recorded but never counts toward paidAmount / balance.
  await recomputeAgreementPaidAndBalance(prisma, agreement.id);

  return created;
}

async function syncMandatoryLocationFees(reservationId, scope = {}) {
  const reservation = await prisma.reservation.findFirst({
    where: scopedReservationWhere(reservationId, scope),
    include: {
      pickupLocation: {
        include: {
          locationFees: {
            include: {
              fee: true
            }
          }
        }
      },
      pricingSnapshot: true,
      charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
    }
  });
  if (!reservation) throw new Error('Reservation not found');

  // Filter mandatory fees by the reservation's booking channel.
  // displayOnline=true fees are website-only and must NOT auto-apply to
  // STAFF or CAR_SHARING reservations. See filterMandatoryFeesForChannel
  // in booking-engine.service.js for the full rule set.
  const mandatoryFees = filterMandatoryFeesForChannel(
    (reservation.pickupLocation?.locationFees || []).map((row) => row.fee),
    reservation.bookingChannel
  );

  const existingCharges = Array.isArray(reservation.charges) ? reservation.charges : [];
  const existingMandatoryCharges = existingCharges.filter((row) => String(row.source || '').toUpperCase() === 'MANDATORY_FEE');
  const chargeByFeeId = new Map(existingMandatoryCharges.map((row) => [String(row.sourceRefId || ''), row]));
  const activeFeeIds = new Set(mandatoryFees.map((fee) => String(fee.id)));
  const baseAmount = Number((toNumber(reservation.pricingSnapshot?.dailyRate, toNumber(reservation.dailyRate)) * rentalDays(reservation.pickupAt, reservation.returnAt)).toFixed(2));
  const days = rentalDays(reservation.pickupAt, reservation.returnAt);
  let nextSortOrder = existingCharges.reduce((max, row) => {
    const sortOrder = Number.isInteger(row?.sortOrder) ? row.sortOrder : Number(row?.sortOrder || 0);
    return Math.max(max, sortOrder);
  }, -1) + 1;

  await prisma.$transaction(async (tx) => {
    for (const fee of mandatoryFees) {
      const existing = chargeByFeeId.get(String(fee.id));
      const total = computeFeeTotal(fee, { baseAmount, days });
      const rate = String(fee.mode || 'FIXED').trim().toUpperCase() === 'PERCENTAGE'
        ? toNumber(fee.amount)
        : total;
      const data = {
        code: fee.code || null,
        name: fee.name,
        chargeType: 'UNIT',
        quantity: 1,
        rate,
        total,
        taxable: !!fee.taxable,
        selected: true,
        notes: 'Auto-applied mandatory location fee'
      };

      if (existing?.id) {
        await tx.reservationCharge.update({
          where: { id: existing.id },
          data
        });
      } else {
        await tx.reservationCharge.create({
          data: {
            reservationId,
            ...data,
            sortOrder: nextSortOrder++,
            source: 'MANDATORY_FEE',
            sourceRefId: fee.id
          }
        });
      }
    }

    const staleIds = existingMandatoryCharges
      .filter((row) => !activeFeeIds.has(String(row.sourceRefId || '')))
      .map((row) => row.id);
    if (staleIds.length) {
      await tx.reservationCharge.deleteMany({
        where: {
          reservationId,
          id: { in: staleIds }
        }
      });
    }

    const refreshedCharges = await tx.reservationCharge.findMany({
      where: { reservationId, selected: true }
    });
    await tx.reservation.update({
      where: { id: reservationId },
      data: { estimatedTotal: summarizeChargeTotals(refreshedCharges).total }
    });
  });

  return mandatoryFees.length;
}

export const reservationPricingService = {
  async getPricing(reservationId, scope = {}, opts = {}) {
    await Promise.all([
      syncMandatoryLocationFees(reservationId, scope),
      tollsService.syncReservationCharges(reservationId, scope),
      syncAgreementCharges(reservationId, scope, opts)
    ]);
    const row = await getReservationOrThrow(reservationId, scope);
    const charges = Array.isArray(row.charges) ? row.charges : [];
    const snapshot = row.pricingSnapshot || null;
    return {
      reservationId: row.id,
      snapshot,
      charges,
      totals: summarizeChargeTotals(charges)
    };
  },

  async replacePricing(reservationId, payload = {}, scope = {}) {
    await getReservationOrThrow(reservationId, scope);

    const snapshotData = buildSnapshotUpsertData(payload);
    // Bug 7b: the manual "Edit pricing" UI doesn't include EXTENSION_RATE
    // rows in its synthesized payload, so a naïve deleteMany+createMany
    // would silently wipe them — leaving the reservation with
    // originalReturnAt set, returnAt extended, and a pending addendum
    // but no charge to anchor a future "Delete extension" against.
    //
    // Codex bot P1 on PR #36: an earlier fix snapshotted EXTENSION_RATE
    // rows and re-inserted them, but createMany generates fresh ids, so
    // RentalAgreementAddendum.extensionChargeId would point at a
    // non-existent charge after Edit+Save, breaking deleteExtension.
    // Cleaner solution: don't delete EXTENSION_RATE rows in the first
    // place. Only wipe the non-extension rows, leave extensions in
    // place with their original ids untouched.
    const chargeRows = buildChargeRows(reservationId, payload.charges || [])
      .filter((row) => String(row?.code || '').toUpperCase() !== 'EXTENSION_RATE');

    await prisma.$transaction(async (tx) => {
      await tx.reservationPricingSnapshot.upsert({
        where: { reservationId },
        create: { reservationId, ...snapshotData },
        update: snapshotData
      });

      // Enumerate ids of non-extension rows. Doing this explicitly
      // sidesteps Prisma's tri-valued logic on `not` against nullable
      // columns (a row with code=NULL would survive `code: { not: '...' }`
      // because NULL != X is NULL, not true). With an `id: { in: [...] }`
      // delete we know exactly which rows go.
      const existing = await tx.reservationCharge.findMany({
        where: { reservationId },
        select: { id: true, code: true }
      });
      const nonExtensionIds = existing
        .filter((c) => String(c?.code || '').toUpperCase() !== 'EXTENSION_RATE')
        .map((c) => c.id);
      if (nonExtensionIds.length) {
        await tx.reservationCharge.deleteMany({
          where: { id: { in: nonExtensionIds } }
        });
      }

      if (chargeRows.length) {
        await tx.reservationCharge.createMany({ data: chargeRows });
      }

      // Re-read EXTENSION_RATE rows so estimatedTotal includes their
      // contribution. Using the live rows (not a snapshot) keeps us
      // honest if anything else in this tx touched them.
      const liveExtensions = await tx.reservationCharge.findMany({
        where: { reservationId, code: 'EXTENSION_RATE' }
      });

      const nextDailyRate = snapshotData.dailyRate;
      const estimatedTotal = summarizeChargeTotals([...chargeRows, ...liveExtensions]).total;
      await tx.reservation.update({
        where: { id: reservationId },
        data: {
          dailyRate: nextDailyRate,
          estimatedTotal
        }
      });
    });

    await syncMandatoryLocationFees(reservationId, scope);
    await tollsService.syncReservationCharges(reservationId, scope);
    // "Edit pricing" is always an explicit operator mutation. Allow it to
    // recompute the agreement total/balance even after check-in (CLOSED) so a
    // post check-in fee reaches the unpaid balance. (2026-06-08 fix.)
    await syncAgreementCharges(reservationId, scope, { allowClosed: true });
    return this.getPricing(reservationId, scope, { allowClosed: true });
  },

  async listPayments(reservationId, scope = {}) {
    const row = await getReservationOrThrow(reservationId, scope);
    return row.payments || [];
  },

  async postPayment(reservationId, payload = {}, scope = {}, actorUserId = null) {
    const amount = toNumber(payload.amount);
    if (!(amount > 0)) throw new Error('amount must be > 0');

    const reservation = await prisma.reservation.findFirst({
      where: scopedReservationWhere(reservationId, scope),
      include: {
        rentalAgreement: {
          select: {
            id: true,
            status: true,
            total: true,
            paidAmount: true,
            balance: true
          }
        }
      }
    });
    if (!reservation) throw new Error('Reservation not found');

    const paidAt = payload.paidAt ? new Date(payload.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new Error('paidAt is invalid');

    const normalizedMethod = normalizePaymentMethod(payload.method);
    const trimmedReference = payload.reference ? String(payload.reference).trim() : null;
    // AUTH_HOLD requires the auth code in `reference` — it's the only audit
    // trail for the swipe (no settled funds, no AuthNet transId).
    if (normalizedMethod === 'AUTH_HOLD' && !trimmedReference) {
      throw new Error('reference is required for AUTH_HOLD payments (auth code)');
    }

    const paymentData = {
      reservationId,
      method: normalizedMethod,
      amount,
      reference: trimmedReference,
      status: String(payload.status || 'PAID').trim().toUpperCase(),
      paidAt,
      origin: normalizePaymentOrigin(payload.origin),
      gateway: payload.gateway ? String(payload.gateway).trim() : null,
      notes: payload.notes ? String(payload.notes) : null
    };

    const created = await prisma.reservationPayment.create({ data: paymentData });

    try {
      const agreementPayment = await maybeCreateAgreementPayment({ reservation, payment: created });
      if (agreementPayment?.id) {
        await prisma.reservationPayment.update({
          where: { id: created.id },
          data: { rentalAgreementPaymentId: agreementPayment.id }
        });
      }
    } catch {
      if (reservation?.rentalAgreement?.id) {
        try {
          // 2026-06-06 Option B: recompute from real (non-AUTH_HOLD) payments.
          await recomputeAgreementPaidAndBalance(prisma, reservation.rentalAgreement.id);
        } catch (agreementErr) {
          logger.warn('reservation-pricing: rentalAgreement balance fallback update failed', {
            reservationId,
            rentalAgreementId: reservation.rentalAgreement.id,
            error: String(agreementErr?.message || agreementErr)
          });
        }
      }
    }

    // If this payment settles a CHECKED_IN_UNPAID reservation (balance now ~0),
    // advance it to CHECKED_IN — mirrors what the autocharge worker does so a
    // manually-collected balance (e.g. tenant autocharge mode = MANUAL) doesn't
    // leave the reservation perpetually "unpaid". Trusts the post-payment
    // agreement balance, so AUTH_HOLD/deposit math is handled upstream.
    try {
      if (reservation.rentalAgreement?.id && String(reservation.status || '').toUpperCase() === 'CHECKED_IN_UNPAID') {
        const settled = await prisma.rentalAgreement.findUnique({
          where: { id: reservation.rentalAgreement.id },
          select: { balance: true }
        });
        if (toNumber(settled?.balance) <= 0.01) {
          await prisma.reservation.update({
            where: { id: reservationId },
            data: { status: 'CHECKED_IN', autochargeAt: null }
          });
          await syncVehicleStatusForReservation(prisma, { reservationId, toStatus: 'CHECKED_IN' });
          await prisma.auditLog.create({
            data: {
              tenantId: reservation.tenantId || null,
              reservationId,
              actorUserId: actorUserId || null,
              action: 'STATUS_CHANGE',
              fromStatus: 'CHECKED_IN_UNPAID',
              toStatus: 'CHECKED_IN',
              reason: 'Balance settled via manual payment',
              metadata: JSON.stringify({ amount, method: paymentData.method })
            }
          }).catch(() => {});
        }
      }
    } catch (settleErr) {
      logger.warn('reservation-pricing: settle-on-payment status advance failed', {
        reservationId, error: String(settleErr?.message || settleErr)
      });
    }

    try {
      await prisma.auditLog.create({
        data: {
          tenantId: reservation.tenantId || null,
          reservationId,
          actorUserId: actorUserId || null,
          action: 'UPDATE',
          metadata: JSON.stringify({
            reservationPaymentPosted: true,
            amount,
            method: paymentData.method,
            origin: paymentData.origin,
            reference: paymentData.reference
          })
        }
      });
    } catch (auditErr) {
      logger.warn('reservation-pricing: auditLog write failed for payment post', {
        reservationId,
        error: String(auditErr?.message || auditErr)
      });
    }

    return prisma.reservationPayment.findUnique({ where: { id: created.id } });
  }
};
