import { prisma } from '../../lib/prisma.js';
import { tollsService } from '../tolls/tolls.service.js';
import { filterMandatoryFeesForChannel } from '../booking-engine/fee-channel-filter.js';
import { evaluateAgeRules } from '../../lib/age-rules.js';
import { parseLocationConfig } from '../../lib/location-config.js';
import { syncVehicleStatusForReservation } from '../vehicles/vehicle-status-sync.js';
import logger from '../../lib/logger.js';
import { computeCheckinFees } from '../fees/fee-engine.service.js';
import {
  computeRentalDays,
  resolveTankCapacity,
  resolveIncludedMilesPerDay
} from '../rental-agreements/checkin-close.service.js';
import { recordMileageEntrySafe } from '../vehicles/mileage-history.service.js';
import { recordFuelReadingSafe } from '../vehicles/fuel-history.service.js';

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

// 2026-07-25 — per-reservation mileage exception (Hector: agents can make
// exceptions to the local/non-local policy). Normalizes payload.mileageOverride:
//   undefined        → field untouched (frontend only sends it when CHANGED)
//   null             → clear any manual mileage (back to rule/vehicle-type/200)
//   { unlimited: true }   → no cap for this reservation
//   { milesPerDay: 200 }  → that cap
// Anything unparseable → undefined (never guess money-adjacent intent).
export function normalizeMileageOverride(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  if (raw.unlimited === true || raw.unlimitedMileage === true) return { unlimited: true };
  const miles = Number(raw.milesPerDay);
  if (Number.isFinite(miles) && miles > 0) return { milesPerDay: Math.round(miles) };
  return undefined;
}

// Merge a mileage override into the frozen deposit-rule decision JSON (the
// single source resolveIncludedMilesPerDay reads, so hold + billing can never
// disagree). mileageSource UI_MANUAL marks it so the pre-check-in
// re-evaluation preserves the agent's exception when it refreshes an
// UNKNOWN-basis decision.
export function mergeMileageOverride(existingJson, override) {
  let decision = null;
  try {
    const parsed = existingJson ? JSON.parse(existingJson) : null;
    decision = parsed && typeof parsed === 'object' ? parsed : null;
  } catch { decision = null; }

  if (override === null) {
    if (!decision) return null;
    // Clearing only removes a MANUAL exception. The rule's own frozen
    // mileage lives in the same keys — stripping it here would delete the
    // contractual cap (LAX local 150 → suddenly vehicle-type/200, or a
    // promised unlimited → billed overage) with no way back, since the
    // re-evaluation never fires on UI_MANUAL snapshots (QA MAJOR A-1).
    if (decision.mileageSource !== 'UI_MANUAL') return existingJson;
    const { milesPerDay, unlimitedMileage, mileageSource, ...rest } = decision;
    return Object.keys(rest).length ? JSON.stringify(rest) : null;
  }

  const base = decision || { locality: null, basis: 'MANUAL' };
  const next = override.unlimited === true
    ? { ...base, unlimitedMileage: true, milesPerDay: null, mileageSource: 'UI_MANUAL' }
    : { ...base, unlimitedMileage: false, milesPerDay: override.milesPerDay, mileageSource: 'UI_MANUAL' };
  return JSON.stringify(next);
}

/**
 * Charge rows the pricing engine does NOT own (2026-08-05).
 *
 * A fee that arrived FROM an upstream system is a fact about what the customer
 * was already quoted — MEX's Customer Facility Charge, Vehicle License Fee and
 * Surcharge come down with the booking and MEX will bill them whatever RFM
 * decides. "Edit pricing → Save Override" rebuilds the charge list from the
 * UI's synthesized payload, which knows nothing about those rows, so a naïve
 * rebuild silently drops a fee the customer already owes. Same failure shape
 * as the EXTENSION_RATE bug below, generalised: preserve by OWNERSHIP, not by
 * one hardcoded code.
 *
 * These rows are still editable/voidable through Admin Corrections — this only
 * stops an unrelated pricing edit from deleting them as collateral.
 */
export const EXTERNALLY_OWNED_CHARGE_SOURCES = Object.freeze(new Set([
  'MEX_IMPORT',
]));

/** True when the pricing engine must leave this row alone. */
export function isExternallyOwnedCharge(row) {
  const source = String(row?.source || '').trim().toUpperCase();
  return EXTERNALLY_OWNED_CHARGE_SOURCES.has(source);
}

/** True when a rebuild must NOT delete this row (extensions + imported fees). */
export function isPreservedOnPricingRebuild(row) {
  if (String(row?.code || '').toUpperCase() === 'EXTENSION_RATE') return true;
  return isExternallyOwnedCharge(row);
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
  // 2026-06-25 (Admin Corrections Option B): ALSO preserve ADMIN_CORRECTION rows
  // (manual charges/credits added by an admin) — they live only on the agreement,
  // like fee-engine fees, and have no ReservationCharge to re-sync from. Without
  // this, a manual charge was deleted by the very recompute that addManualCharge
  // triggers ("add doesn't add"). Voided rows (selected=false) are kept here too
  // (the delete is source-based, not selected-based) so the recompute's
  // selected:true filter excludes them from totals while keeping them for history.
  // 2026-07-10 (Report Damage, Feature 3): ALSO preserve DAMAGE_CHARGE rows — the
  // damage charge added inside the Report Damage flow lives only on the agreement
  // (no ReservationCharge to re-sync from), exactly like FEE_ENGINE_ / ADMIN_CORRECTION
  // rows. Without this carve-out the very recompute the charge triggers would wipe it.
  // 2026-07-13 (RES-213665): NULL-SAFE delete. Prisma/Postgres string filters
  // (negated or not) never match NULL — so legacy mirror rows written with
  // source:null survived every resync and DUPLICATED the agreement (23
  // agreements found in prod with doubled DAILY/TAX rows).
  //
  // QA B1 guard: the { source: null } arm applies ONLY when we have a fresh
  // mirror set to write (chargeRows.length > 0). Branch-3 agreements
  // (startFromReservation synthesizes Daily/fees/Tax with source:null for
  // reservations that have NO ReservationCharge rows) would otherwise be
  // wiped by any pricing read — deleted with nothing to recreate them from.
  // Duplication can only happen when a new mirror set lands next to the old
  // null rows, so gating the null-purge on a non-empty rebuild keeps the
  // RES-213665 fix intact.
  const preservedCarveOut = {
    AND: [
      { NOT: { source: { startsWith: 'FEE_ENGINE_' } } },
      { NOT: { source: 'ADMIN_CORRECTION' } },
      { NOT: { source: 'DAMAGE_CHARGE' } }
    ]
  };
  await prisma.rentalAgreementCharge.deleteMany({
    where: {
      rentalAgreementId: agreement.id,
      ...(chargeRows.length
        ? { OR: [{ source: null }, preservedCarveOut] }
        : preservedCarveOut)
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
  // Only CANCELLED is hard-blocked. A CLOSED agreement is still adjustable by admins
  // (mirrors the allowClosed pattern in void/correction paths) — recording a payment
  // on it must create the agreement-ledger row and recompute, or the balance goes stale.
  if (String(agreement.status || '').toUpperCase() === 'CANCELLED') return null;

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
      customer: { select: { dateOfBirth: true } },
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

  // 2026-07-28 AGE RULES (LAX): with ageRulesEnforced on the pickup location
  // and the driver inside the [chargeAgeMin..underageFeeMaxAge] band, every
  // active isUnderageFee fee LINKED TO THE LOCATION auto-applies as a
  // mandatory charge (source UNDERAGE_FEE). Age is recomputed HERE, from the
  // customer's current DOB — unlike the legacy reservation.underageAlert flag,
  // which froze at reservation time and never saw a DOB corrected at the
  // counter. No channel filter: the fee is a counter/legal rule, not a
  // website-display one. Outside the band (or unenforced) the rows are
  // removed like any stale mandatory fee.
  const ageEval = evaluateAgeRules({
    dateOfBirth: reservation.customer?.dateOfBirth ?? null,
    pickupAt: reservation.pickupAt,
    locationConfig: parseLocationConfig(reservation.pickupLocation?.locationConfig),
  });
  const underageFees = ageEval.feeApplies
    ? (reservation.pickupLocation?.locationFees || [])
      .map((row) => row.fee)
      .filter((fee) => fee?.isActive && fee?.isUnderageFee)
    : [];

  const existingCharges = Array.isArray(reservation.charges) ? reservation.charges : [];
  const existingMandatoryCharges = existingCharges.filter(
    (row) => ['MANDATORY_FEE', 'UNDERAGE_FEE'].includes(String(row.source || '').toUpperCase())
  );
  const chargeByFeeId = new Map(existingMandatoryCharges.map((row) => [String(row.sourceRefId || ''), row]));
  const activeFeeIds = new Set([...mandatoryFees, ...underageFees].map((fee) => String(fee.id)));
  const baseAmount = Number((toNumber(reservation.pricingSnapshot?.dailyRate, toNumber(reservation.dailyRate)) * rentalDays(reservation.pickupAt, reservation.returnAt)).toFixed(2));
  const days = rentalDays(reservation.pickupAt, reservation.returnAt);
  let nextSortOrder = existingCharges.reduce((max, row) => {
    const sortOrder = Number.isInteger(row?.sortOrder) ? row.sortOrder : Number(row?.sortOrder || 0);
    return Math.max(max, sortOrder);
  }, -1) + 1;

  // A fee flagged both mandatory and isUnderageFee is owned by the mandatory
  // set (it applies at every age) — dedup so it can't create two rows.
  const mandatoryIds = new Set(mandatoryFees.map((fee) => String(fee.id)));
  const feeGroups = [
    { fees: mandatoryFees, source: 'MANDATORY_FEE', notes: 'Auto-applied mandatory location fee' },
    {
      fees: underageFees.filter((fee) => !mandatoryIds.has(String(fee.id))),
      source: 'UNDERAGE_FEE',
      notes: `Auto-applied underage fee (driver age ${ageEval.age})`
    },
  ];

  await prisma.$transaction(async (tx) => {
    for (const group of feeGroups) {
      for (const fee of group.fees) {
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
          notes: group.notes
        };

        if (existing?.id) {
          // 2026-06-25 (Admin Corrections Option B): if an admin explicitly voided this
          // mandatory fee (selected=false), DON'T re-select it here — otherwise the void
          // would rebound on the next pricing recompute. Normal flow keeps selected=true.
          await tx.reservationCharge.update({
            where: { id: existing.id },
            data: existing.selected === false ? { ...data, selected: false } : data
          });
        } else {
          await tx.reservationCharge.create({
            data: {
              reservationId,
              ...data,
              sortOrder: nextSortOrder++,
              source: group.source,
              sourceRefId: fee.id
            }
          });
        }
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
      // skipAgreementMirror: syncAgreementCharges runs right below in this
      // same Promise.all — the toll sync's own post-close mirror (2026-07-26)
      // would race a second concurrent agreement rebuild here.
      tollsService.syncReservationCharges(reservationId, scope, { skipAgreementMirror: true }),
      syncAgreementCharges(reservationId, scope, opts)
    ]);
    const row = await getReservationOrThrow(reservationId, scope);
    // 2026-06-25: exclude voided charges (selected=false, e.g. an Admin Corrections void)
    // from the displayed pricing AND its totals, so a voided charge disappears from the
    // breakdown everywhere — matching the recomputed agreement balance. The row stays in
    // the DB (selected=false) for history + AuditLog.
    const charges = (Array.isArray(row.charges) ? row.charges : []).filter((c) => c?.selected !== false);
    const snapshot = row.pricingSnapshot || null;
    return {
      reservationId: row.id,
      snapshot,
      charges,
      totals: summarizeChargeTotals(charges)
    };
  },

  // ── Admin Corrections (Fase 1) — ADMIN-only (gated at the route). Every mutation
  // recomputes the agreement via syncAgreementCharges({ allowClosed:true }) — the
  // engine's own formula — so fees/total/balance never drift, and writes an
  // AuditLog(ADMIN_OVERRIDE) with before/after balance + the required reason.
  async voidAgreementCharge(reservationId, chargeId, opts = {}, scope = {}) {
    const { reason = null, actorUserId = null } = opts;
    await getReservationOrThrow(reservationId, scope); // validates existence + tenant scope
    const agreement = await prisma.rentalAgreement.findFirst({
      where: { reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, tenantId: true, balance: true }
    });
    if (!agreement) { const e = new Error('No agreement for reservation'); e.status = 404; throw e; }
    const balanceBefore = Number(agreement.balance || 0);

    // Void at the correct SOURCE. Fee-engine fees and admin manual charges live only on the
    // agreement (RentalAgreementCharge) and are preserved across recomputes, so soft-voiding
    // the agreement row sticks. Everything else (daily, insurance/CDW, mandatory, tolls, taxes)
    // is a ReservationCharge that syncAgreementCharges REBUILDS from — voiding the agreement
    // row there would just be regenerated, so we void the ReservationCharge. We detect the
    // space by looking the id up in each table (the panel sends the row's real id + scope).
    let voided = null; // { id, name, total, source, space }
    const agreementCharge = await prisma.rentalAgreementCharge.findFirst({
      where: { id: String(chargeId), rentalAgreementId: agreement.id },
      select: { id: true, name: true, total: true, source: true, selected: true }
    });
    if (agreementCharge) {
      if (agreementCharge.selected === false) { const e = new Error('Charge is already voided'); e.status = 409; throw e; }
      // selected=false keeps the row for history; syncAgreementCharges preserves FEE_ENGINE_
      // and ADMIN_CORRECTION rows and only sums selected:true, so the void sticks.
      await prisma.rentalAgreementCharge.update({ where: { id: agreementCharge.id }, data: { selected: false } });
      voided = { id: agreementCharge.id, name: agreementCharge.name, total: Number(agreementCharge.total || 0), source: agreementCharge.source || null, space: 'agreement' };
    } else {
      const reservationCharge = await prisma.reservationCharge.findFirst({
        where: { id: String(chargeId), reservationId },
        select: { id: true, name: true, total: true, source: true, sourceRefId: true, selected: true }
      });
      if (!reservationCharge) { const e = new Error('Charge not found on this reservation'); e.status = 404; throw e; }
      if (reservationCharge.selected === false) { const e = new Error('Charge is already voided'); e.status = 409; throw e; }
      // syncAgreementCharges rebuilds the agreement rows from selected:true ReservationCharges,
      // so selected=false removes it from the balance and keeps the row for history.
      await prisma.reservationCharge.update({ where: { id: reservationCharge.id }, data: { selected: false } });
      voided = { id: reservationCharge.id, name: reservationCharge.name, total: Number(reservationCharge.total || 0), source: reservationCharge.source || null, sourceRefId: reservationCharge.sourceRefId || null, space: 'reservation' };
    }

    // RES-849093 FIX 2a: when the voided charge is a TOLL charge, ALSO void the
    // underlying tollTransaction so syncReservationTollCharges does not re-create
    // it from the still-MATCHED transaction (which made tolls impossible to void).
    // TOLL_MODULE charges carry the transaction id in sourceRefId; void it directly.
    // TOLL_POLICY is the per-reservation policy fee (sourceRefId `reservation:<id>`,
    // not a single transaction) — re-running the toll sync below recomputes it from
    // whatever transactions remain, so no per-transaction void is needed there.
    const voidedSource = String(voided.source || '').toUpperCase();
    let tollSyncErr = null;
    if (voidedSource === 'TOLL_MODULE' && voided.sourceRefId) {
      try {
        await tollsService.voidTollTransaction(voided.sourceRefId, scope, { note: reason || null });
        await tollsService.syncReservationCharges(reservationId, scope);
      } catch (e) { tollSyncErr = e?.message || String(e); }
    } else if (voidedSource === 'TOLL_POLICY') {
      try {
        await tollsService.syncReservationCharges(reservationId, scope);
      } catch (e) { tollSyncErr = e?.message || String(e); }
    }

    await syncAgreementCharges(reservationId, scope, { allowClosed: true });
    const after = await prisma.rentalAgreement.findUnique({ where: { id: agreement.id }, select: { balance: true } });
    await prisma.auditLog.create({ data: {
      tenantId: agreement.tenantId || null,
      reservationId,
      action: 'ADMIN_OVERRIDE',
      actorUserId: actorUserId || null,
      reason: reason ? String(reason).slice(0, 500) : null,
      metadata: JSON.stringify({
        kind: 'void_charge',
        tollTransactionVoided: voidedSource === 'TOLL_MODULE' ? (voided.sourceRefId || null) : null,
        tollSyncError: tollSyncErr,
        space: voided.space,
        chargeId: voided.id,
        chargeName: voided.name,
        chargeTotal: voided.total,
        chargeSource: voided.source,
        balanceBefore,
        balanceAfter: Number(after?.balance || 0)
      })
    }});
    return this.getPricing(reservationId, scope, { allowClosed: true });
  },

  // ── Admin Corrections — VOID a payment with NO refund (bookkeeping only).
  // Use when a payment was recorded in error: it marks the ReservationPayment
  // (and its linked RentalAgreementPayment, if any) status=VOID so it drops out
  // of the collected/balance math (recompute sums only PAID non-AUTH_HOLD rows).
  // This performs NO gateway call and moves NO money — for a real card refund use
  // the "Refund" action instead. AUTH_HOLD rows are refused (use Release Deposit
  // Hold for the security deposit). ADMIN-only (gated at the route). Recomputes the
  // agreement balance via syncAgreementCharges({ allowClosed:true }) and writes an
  // AuditLog(ADMIN_OVERRIDE) with before/after balance + the required reason.
  async voidPaymentNoRefund(reservationId, paymentId, opts = {}, scope = {}) {
    const { reason = null, actorUserId = null } = opts;
    const cleanReason = reason ? String(reason).trim() : '';
    if (!cleanReason) { const e = new Error('reason is required'); e.status = 400; throw e; }
    await getReservationOrThrow(reservationId, scope); // validates existence + tenant scope

    // ReservationPayment has no tenantId column — tenant isolation is enforced by
    // getReservationOrThrow above (tenant-scoped) + the reservationId constraint here.
    const payment = await prisma.reservationPayment.findFirst({
      where: { id: String(paymentId), reservationId },
      select: { id: true, method: true, amount: true, status: true, reference: true, rentalAgreementPaymentId: true }
    });
    if (!payment) { const e = new Error('Payment not found on this reservation'); e.status = 404; throw e; }
    if (String(payment.method || '').toUpperCase() === 'AUTH_HOLD') {
      const e = new Error('Use Release Deposit Hold for the security deposit, not void.'); e.status = 400; throw e;
    }
    if (String(payment.status || '').toUpperCase() === 'VOID') {
      const e = new Error('Payment already voided'); e.status = 409; throw e;
    }
    // Guard: if this payment was already refunded (a REFUND counter-row exists),
    // voiding it would double-subtract from collected. Refuse.
    const priorRefund = await prisma.reservationPayment.findFirst({
      where: {
        reservationId,
        // Only NON-voided refunds block: if the admin already voided the refund
        // counter-row, the original no longer nets out and must be voidable.
        status: { not: 'VOID' },
        OR: [
          { reference: { contains: `REFUND:${payment.id}` } },
          { notes: { contains: `Refund for payment ${payment.id}` } }
        ]
      },
      select: { id: true }
    });
    if (priorRefund) {
      const e = new Error('This payment was already refunded; voiding it would double-count. Handle the refund record instead.');
      e.status = 409; throw e;
    }

    const agreement = await prisma.rentalAgreement.findFirst({
      where: { reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, tenantId: true, balance: true }
    });
    const balanceBefore = Number(agreement?.balance || 0);

    // Bookkeeping only: flip BOTH ledgers to VOID in one tx so they stay consistent.
    // NO gateway / Authorize.Net / SPIn call — this does not touch the card.
    await prisma.$transaction(async (tx) => {
      await tx.reservationPayment.update({ where: { id: payment.id }, data: { status: 'VOID' } });
      if (payment.rentalAgreementPaymentId) {
        await tx.rentalAgreementPayment.update({
          where: { id: payment.rentalAgreementPaymentId },
          data: { status: 'VOID' }
        });
      }
    });

    // Recompute balance — the engine sums only PAID non-AUTH_HOLD rows, so the
    // voided payment now correctly drops out of collected/balance.
    await syncAgreementCharges(reservationId, scope, { allowClosed: true });
    const after = agreement
      ? await prisma.rentalAgreement.findUnique({ where: { id: agreement.id }, select: { balance: true } })
      : null;
    const balanceAfter = Number(after?.balance ?? balanceBefore);

    await prisma.auditLog.create({ data: {
      tenantId: agreement?.tenantId || scope?.tenantId || null,
      reservationId,
      action: 'ADMIN_OVERRIDE',
      actorUserId: actorUserId || null,
      reason: cleanReason.slice(0, 500),
      metadata: JSON.stringify({
        kind: 'void_payment_no_refund',
        paymentId: payment.id,
        amount: Number(payment.amount || 0),
        method: payment.method || null,
        reference: payment.reference || null,
        balanceBefore,
        balanceAfter,
        reason: cleanReason.slice(0, 500)
      })
    }});

    return { ok: true, balanceBefore, balanceAfter };
  },

  async addManualCharge(reservationId, body = {}, opts = {}, scope = {}) {
    const { reason = null, actorUserId = null, returnMeta = false } = opts;
    const name = String(body?.name || '').trim();
    const amount = Number(body?.amount);
    // Optional source tag. Defaults to ADMIN_CORRECTION so every EXISTING caller
    // (Admin Corrections panel, VozIA service account) is byte-for-byte unchanged.
    // The Report Damage flow (Feature 3) passes 'DAMAGE_CHARGE' — which is carved
    // out of the recompute deleteMany in syncAgreementCharges and surfaced by
    // listAgreementCharges exactly like ADMIN_CORRECTION, so the charge sticks and
    // is voidable from Admin Corrections. Any other value falls back to the default.
    const source = ['ADMIN_CORRECTION', 'DAMAGE_CHARGE'].includes(String(body?.source || '').toUpperCase())
      ? String(body.source).toUpperCase()
      : 'ADMIN_CORRECTION';
    if (!name) { const e = new Error('name is required'); e.status = 400; throw e; }
    if (!Number.isFinite(amount) || amount === 0) { const e = new Error('amount must be a non-zero number'); e.status = 400; throw e; }
    await getReservationOrThrow(reservationId, scope);
    const agreement = await prisma.rentalAgreement.findFirst({
      where: { reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, tenantId: true, balance: true }
    });
    if (!agreement) { const e = new Error('No agreement for reservation'); e.status = 404; throw e; }
    const rounded = Math.round(amount * 100) / 100; // negative = credit
    const balanceBefore = Number(agreement.balance || 0);
    // source ADMIN_CORRECTION (not FEE_ENGINE*, not TAX, not deposit) → lands in
    // subtotal in the recompute, so it moves total/balance by exactly its amount.
    const created = await prisma.rentalAgreementCharge.create({ data: {
      rentalAgreementId: agreement.id,
      name: name.slice(0, 200),
      chargeType: 'UNIT',
      quantity: 1,
      rate: rounded,
      total: rounded,
      taxable: false,
      selected: true,
      source
    }, select: { id: true } });
    await syncAgreementCharges(reservationId, scope, { allowClosed: true });
    const after = await prisma.rentalAgreement.findUnique({ where: { id: agreement.id }, select: { balance: true } });
    await prisma.auditLog.create({ data: {
      tenantId: agreement.tenantId || null,
      reservationId,
      action: 'ADMIN_OVERRIDE',
      actorUserId: actorUserId || null,
      reason: reason ? String(reason).slice(0, 500) : null,
      metadata: JSON.stringify({
        kind: rounded < 0 ? 'add_credit' : 'add_charge',
        chargeId: created.id,
        source,
        name: name.slice(0, 200),
        amount: rounded,
        balanceBefore,
        balanceAfter: Number(after?.balance || 0)
      })
    }});
    const pricing = await this.getPricing(reservationId, scope, { allowClosed: true });
    // Default return is the pricing object (unchanged for every existing caller).
    // The Report Damage orchestrator passes opts.returnMeta to also get the new
    // chargeId (to cross-link it onto the VehicleDamageReport) + before/after balance.
    if (returnMeta) {
      return { pricing, chargeId: created.id, source, balanceBefore, balanceAfter: Number(after?.balance || 0) };
    }
    return pricing;
  },

  // Admin Corrections — the agreement-level charge rows (RentalAgreementCharge),
  // which is what void/add operate on AND where post-check-in fee-engine fees live.
  // NOTE: getPricing().charges are ReservationCharge (the estimate) with DIFFERENT ids,
  // so the corrections panel MUST use this, not getPricing.
  async listAgreementCharges(reservationId, scope = {}) {
    await getReservationOrThrow(reservationId, scope);
    const agreement = await prisma.rentalAgreement.findFirst({
      where: { reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, balance: true, total: true }
    });
    if (!agreement) return { charges: [], balance: 0, total: 0 };
    // The balance is driven by charges in TWO spaces (see voidAgreementCharge):
    //   - reservation-sourced charges (daily, insurance/CDW, mandatory, tolls, taxes) are
    //     ReservationCharge rows — voiding happens there (scope:'reservation').
    //   - agreement-only charges (post-check-in fee-engine fees + admin manual charges) are
    //     RentalAgreementCharge rows — voiding happens there (scope:'agreement').
    // List each with its REAL id + scope so the void targets the right table.
    const [resRows, agreementRows] = await Promise.all([
      prisma.reservationCharge.findMany({
        where: { reservationId, selected: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, total: true, source: true, chargeType: true, taxable: true }
      }),
      prisma.rentalAgreementCharge.findMany({
        where: {
          rentalAgreementId: agreement.id,
          selected: true,
          OR: [{ source: { startsWith: 'FEE_ENGINE_' } }, { source: 'ADMIN_CORRECTION' }, { source: 'DAMAGE_CHARGE' }]
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, total: true, source: true, chargeType: true, taxable: true }
      })
    ]);
    const charges = [
      ...resRows.map((c) => ({ ...c, total: Number(c.total || 0), scope: 'reservation' })),
      ...agreementRows.map((c) => ({ ...c, total: Number(c.total || 0), scope: 'agreement' }))
    ];
    return {
      charges,
      balance: Number(agreement.balance || 0),
      total: Number(agreement.total || 0)
    };
  },

  // ── Admin Corrections: correct checkout/check-in fuel + odometer + cleanliness
  // and RE-RUN the check-in fee engine (2026-06-29). ADMIN-only (gated at route).
  // Fixes "the agent fat-fingered the odometer/fuel at checkout or check-in and the
  // wrong excess-mileage / fuel-refill fee posted". We soft-void the old fee-engine
  // rows (kept for history), persist the corrected inspection columns, and let
  // computeCheckinFees recompute fees + agreement total/balance with the SAME input
  // resolvers the first-run check-in used (computeRentalDays / resolveTankCapacity /
  // resolveIncludedMilesPerDay, exported from checkin-close.service.js) so corrected
  // fees match first-run fees exactly. Allows CLOSED/locked agreements (the whole
  // point — fixing a finalized rental); refuses CANCELLED. Writes an
  // AuditLog(ADMIN_OVERRIDE) with old/new readings, fee breakdown before/after,
  // balanceBefore/After + the required reason. Supports dryRun for a live preview.
  async correctInspectionValues(reservationId, payload = {}, scope = {}) {
    const { reason = null, actorUserId = null, dryRun = false } = payload;
    const reasonStr = String(reason || '').trim();
    if (!dryRun && !reasonStr) { const e = new Error('reason is required'); e.status = 400; throw e; }

    await getReservationOrThrow(reservationId, scope); // validates existence + tenant scope

    const agreement = await prisma.rentalAgreement.findFirst({
      where: { reservationId, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      orderBy: { createdAt: 'desc' }
    });
    if (!agreement) { const e = new Error('No agreement for reservation'); e.status = 404; throw e; }
    if (String(agreement.status || '').toUpperCase() === 'CANCELLED') {
      const e = new Error('Cannot correct readings on a cancelled agreement'); e.status = 400; throw e;
    }

    const balanceBefore = Number(agreement.balance || 0);

    // Resolve the NEW values: take the supplied ones, fall back to the agreement's
    // current value for the rest (so a partial correction only moves what changed).
    const fuelToFrac = (v) => (v == null ? null : Number(v));
    const odoToInt = (v) => (v == null ? null : Math.round(Number(v)));
    const has = (k) => payload[k] !== undefined && payload[k] !== null && String(payload[k]).trim?.() !== '';

    const newFuelOut       = has('fuelOut')        ? fuelToFrac(payload.fuelOut)        : (agreement.fuelOut == null ? null : Number(agreement.fuelOut));
    const newFuelIn        = has('fuelIn')         ? fuelToFrac(payload.fuelIn)         : (agreement.fuelIn == null ? null : Number(agreement.fuelIn));
    const newOdometerOut   = has('odometerOut')    ? odoToInt(payload.odometerOut)      : (agreement.odometerOut ?? null);
    const newOdometerIn    = has('odometerIn')     ? odoToInt(payload.odometerIn)       : (agreement.odometerIn ?? null);
    const newCleanlinessOut = has('cleanlinessOut') ? odoToInt(payload.cleanlinessOut)  : (agreement.cleanlinessOut ?? null);
    const newCleanlinessIn  = has('cleanlinessIn')  ? odoToInt(payload.cleanlinessIn)   : (agreement.cleanlinessIn ?? null);

    // Shared fee-engine inputs (same resolvers as first-run check-in close).
    const rentalDays = computeRentalDays(agreement.pickupAt, agreement.returnAt);
    const { gallons: tankCapacityGallons, isFallback: tankCapacityIsFallback } = await resolveTankCapacity(agreement);
    const includedMilesPerDay = await resolveIncludedMilesPerDay(agreement);
    const locationId = agreement.pickupLocationId || agreement.returnLocationId;

    const feeInputs = {
      reservationId,
      rentalAgreementId: agreement.id,
      tenantId: agreement.tenantId,
      locationId,
      odometerOut: newOdometerOut,
      odometerIn: newOdometerIn,
      fuelOut: newFuelOut,
      fuelIn: newFuelIn,
      // Scope of this correction = fuel + odometer ONLY. Pass cleanliness as null and
      // smokingDetected false + no late-return inputs so computeCheckinFees re-emits ONLY
      // FUEL_REFILL / EXCESS_MILEAGE. Any existing CLEANING_*/SMOKING/LATE_RETURN rows are
      // deliberately left untouched below, so they survive the recompute (financial safety).
      cleanlinessOut: null,
      cleanlinessIn: null,
      smokingDetected: false,
      includedMilesPerDay,
      rentalDays,
      tankCapacityGallons,
      tankCapacityIsFallback
    };

    // Pull the current fee-engine breakdown (the "before") from the live charges.
    const beforeFeeRows = await prisma.rentalAgreementCharge.findMany({
      where: { rentalAgreementId: agreement.id, source: 'FEE_ENGINE_CHECKIN', selected: true },
      select: { total: true, sourceRefId: true }
    });
    const beforeFee = (type) => Number((beforeFeeRows
      .filter((r) => String(r.sourceRefId || '').toUpperCase() === type)
      .reduce((s, r) => s + Number(r.total || 0), 0)).toFixed(2));
    const before = {
      fuelRefill: beforeFee('FUEL_REFILL'),
      mileageFee: beforeFee('EXCESS_MILEAGE'),
      balance: balanceBefore
    };

    // Helper: derive the preview "after" fees from a computeCheckinFees result.
    const feeFromItems = (items, type) => Number((Array.isArray(items) ? items : [])
      .filter((i) => String(i.feeType || '').toUpperCase() === type)
      .reduce((s, i) => s + Number(i.total || 0), 0).toFixed(2));

    // ── dryRun: compute fees WITHOUT persisting, return a preview only. ──
    if (dryRun) {
      const dry = await computeCheckinFees({ ...feeInputs, persist: false });
      const afterFuel = feeFromItems(dry.items, 'FUEL_REFILL');
      const afterMileage = feeFromItems(dry.items, 'EXCESS_MILEAGE');
      // Project the balance: replace the old fee-engine fuel+mileage portion with
      // the new one. (Other fee-engine fees — cleaning/smoking/late — are untouched
      // by a fuel/odometer correction here since smokingDetected:false and we only
      // change fuel/odo, but we keep the projection scoped to the two corrected
      // line items, which is what the panel shows.)
      const afterBalance = Number(Math.max(0,
        balanceBefore - before.fuelRefill - before.mileageFee + afterFuel + afterMileage
      ).toFixed(2));
      const after = { fuelRefill: afterFuel, mileageFee: afterMileage, balance: afterBalance };
      return { ok: true, preview: { before, after, balanceDelta: Number((after.balance - before.balance).toFixed(2)) } };
    }

    // ── Real save: persist inside a transaction. ──
    await prisma.$transaction(async (tx) => {
      // c. Persist only the supplied inspection columns on the agreement.
      const data = {};
      if (has('fuelOut')) data.fuelOut = newFuelOut;
      if (has('fuelIn')) data.fuelIn = newFuelIn;
      if (has('odometerOut')) data.odometerOut = newOdometerOut;
      if (has('odometerIn')) data.odometerIn = newOdometerIn;
      if (has('cleanlinessOut')) data.cleanlinessOut = newCleanlinessOut;
      if (has('cleanlinessIn')) data.cleanlinessIn = newCleanlinessIn;
      if (Object.keys(data).length) {
        await tx.rentalAgreement.update({ where: { id: agreement.id }, data });
      }

      // d. Soft-void ONLY the fee-engine rows this correction recomputes (fuel + mileage).
      // CLEANING_*/SMOKING/LATE_RETURN rows are NOT touched, so correcting fuel/odometer
      // never silently erases an unrelated fee. Voided rows are kept for audit history.
      await tx.rentalAgreementCharge.updateMany({
        where: {
          rentalAgreementId: agreement.id,
          source: 'FEE_ENGINE_CHECKIN',
          selected: true,
          sourceRefId: { in: ['FUEL_REFILL', 'EXCESS_MILEAGE'] }
        },
        data: { selected: false }
      });
    });

    // e. Re-run the fee engine with persist:true — it recreates FEE_ENGINE_CHECKIN
    // rows and recomputes agreement subtotal/fees/total/balance internally. Run
    // OUTSIDE the tx above to match how checkin-close calls it (it uses its own
    // $transaction for the charge inserts).
    const feeResult = await computeCheckinFees({ ...feeInputs, persist: true, actorUserId });

    // B1 fix: computeCheckinFees only recomputes agreement totals when it persists at
    // least one fee (items.length > 0). When a correction zeroes BOTH fuel and mileage
    // (the headline "remove the stuck fuel charge" case) no row is written, so the
    // denormalized balance would stay stale. Recompute unconditionally here — the same
    // canonical recompute void/addManualCharge use; it preserves FEE_ENGINE_/ADMIN rows.
    await syncAgreementCharges(reservationId, scope, { allowClosed: true });

    // f. Append vehicle history rows for the corrected readings (fail-open).
    const reservationNumber = (await prisma.reservation.findUnique({
      where: { id: reservationId }, select: { reservationNumber: true }
    }).catch(() => null))?.reservationNumber || null;

    const odoChanged = (has('odometerOut') || has('odometerIn'));
    if (agreement.vehicleId && odoChanged) {
      // The "latest" odometer for the vehicle profile is the check-in reading if
      // present, else the checkout reading.
      const latestOdo = newOdometerIn != null ? newOdometerIn : newOdometerOut;
      if (latestOdo != null) {
        await recordMileageEntrySafe(prisma, {
          vehicleId: agreement.vehicleId,
          tenantId: agreement.tenantId ?? null,
          mileage: latestOdo,
          source: 'MANUAL',
          reservationId,
          rentalAgreementId: agreement.id,
          reservationNumber,
          note: `Admin correction: ${reasonStr}`.slice(0, 500),
          actorUserId: actorUserId || null
        });
      }
    }
    const fuelChanged = (has('fuelOut') || has('fuelIn'));
    if (agreement.vehicleId && fuelChanged) {
      const latestFuel = newFuelIn != null ? newFuelIn : newFuelOut;
      if (latestFuel != null) {
        await recordFuelReadingSafe(prisma, {
          vehicleId: agreement.vehicleId,
          tenantId: agreement.tenantId ?? null,
          fuelFraction: latestFuel,
          source: 'CORRECTION',
          reservationId,
          rentalAgreementId: agreement.id,
          reservationNumber,
          note: `Admin correction: ${reasonStr}`.slice(0, 500),
          actorUserId: actorUserId || null
        });
      }
    }

    // Re-read the post-recompute balance.
    const afterAgreement = await prisma.rentalAgreement.findUnique({
      where: { id: agreement.id }, select: { balance: true }
    });
    const balanceAfter = Number(afterAgreement?.balance || 0);
    const after = {
      fuelRefill: feeFromItems(feeResult.items, 'FUEL_REFILL'),
      mileageFee: feeFromItems(feeResult.items, 'EXCESS_MILEAGE'),
      balance: balanceAfter
    };
    const balanceDelta = Number((balanceAfter - balanceBefore).toFixed(2));

    // g. AuditLog(ADMIN_OVERRIDE) with old/new readings + fee breakdown before/after.
    await prisma.auditLog.create({ data: {
      tenantId: agreement.tenantId || null,
      reservationId,
      action: 'ADMIN_OVERRIDE',
      actorUserId: actorUserId || null,
      reason: reasonStr.slice(0, 500),
      metadata: JSON.stringify({
        kind: 'correct_readings',
        old: {
          fuelOut: agreement.fuelOut == null ? null : Number(agreement.fuelOut),
          fuelIn: agreement.fuelIn == null ? null : Number(agreement.fuelIn),
          odometerOut: agreement.odometerOut ?? null,
          odometerIn: agreement.odometerIn ?? null,
          cleanlinessOut: agreement.cleanlinessOut ?? null,
          cleanlinessIn: agreement.cleanlinessIn ?? null
        },
        new: {
          fuelOut: newFuelOut, fuelIn: newFuelIn,
          odometerOut: newOdometerOut, odometerIn: newOdometerIn,
          cleanlinessOut: newCleanlinessOut, cleanlinessIn: newCleanlinessIn
        },
        fees: { before, after },
        balanceBefore, balanceAfter
      })
    }}).catch((e) => {
      logger.warn('[reservation-pricing] correctInspectionValues audit log failed', {
        reservationId, message: e?.message || String(e)
      });
    });

    return { ok: true, preview: { before, after, balanceDelta } };
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
      .filter((row) => !isPreservedOnPricingRebuild(row));

    const mileageOverride = normalizeMileageOverride(payload.mileageOverride);

    await prisma.$transaction(async (tx) => {
      // Mileage exception rides inside securityDepositRuleJson (merged, never
      // replaced — the locality/deposit half of an existing decision survives).
      let rulePatch = {};
      if (mileageOverride !== undefined) {
        const existingSnap = await tx.reservationPricingSnapshot.findUnique({
          where: { reservationId },
          select: { securityDepositRuleJson: true }
        });
        rulePatch = {
          securityDepositRuleJson: mergeMileageOverride(existingSnap?.securityDepositRuleJson, mileageOverride)
        };
      }

      await tx.reservationPricingSnapshot.upsert({
        where: { reservationId },
        create: { reservationId, ...snapshotData, ...rulePatch },
        update: { ...snapshotData, ...rulePatch }
      });

      // Enumerate ids of non-extension rows. Doing this explicitly
      // sidesteps Prisma's tri-valued logic on `not` against nullable
      // columns (a row with code=NULL would survive `code: { not: '...' }`
      // because NULL != X is NULL, not true). With an `id: { in: [...] }`
      // delete we know exactly which rows go.
      const existing = await tx.reservationCharge.findMany({
        where: { reservationId },
        select: { id: true, code: true, source: true }
      });
      const rebuildableIds = existing
        .filter((c) => !isPreservedOnPricingRebuild(c))
        .map((c) => c.id);
      if (rebuildableIds.length) {
        await tx.reservationCharge.deleteMany({
          where: { id: { in: rebuildableIds } }
        });
      }

      if (chargeRows.length) {
        await tx.reservationCharge.createMany({ data: chargeRows });
      }

      // Re-read EXTENSION_RATE rows so estimatedTotal includes their
      // contribution. Using the live rows (not a snapshot) keeps us
      // honest if anything else in this tx touched them.
      // Every row that survived the rebuild still contributes to the total —
      // a preserved fee the customer owes must not vanish from estimatedTotal
      // just because the pricing engine did not author it.
      const livePreserved = (await tx.reservationCharge.findMany({
        where: { reservationId }
      })).filter((c) => isPreservedOnPricingRebuild(c));

      const nextDailyRate = snapshotData.dailyRate;
      const estimatedTotal = summarizeChargeTotals([...chargeRows, ...livePreserved]).total;
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

    // B5 Phase 1 idempotency floor (2026-07-24). A partial unique index covers
    // MACHINE-generated references only (IPOS:/AUTHNET:/SPIN: — see migration
    // 20260724_kiosk_b5_phase1; a blanket constraint is impossible because
    // staff legitimately type the same manual reference twice on one
    // reservation). If a concurrent webhook+poll pair races past the caller's
    // findFirst dedupe, Postgres rejects the loser with P2002 and we return the
    // row the winner created instead of double-posting.
    //
    // PURE SAFETY NET: on any non-P2002 error, and for every manual reference
    // (not covered by the index), behavior is byte-identical to before.
    let created;
    try {
      created = await prisma.reservationPayment.create({ data: paymentData });
    } catch (err) {
      if (err?.code !== 'P2002' || !trimmedReference) throw err;
      const existing = await prisma.reservationPayment.findFirst({
        where: { reservationId, reference: trimmedReference },
        orderBy: { createdAt: 'asc' }
      });
      if (!existing) throw err;
      logger.warn('reservation-pricing: duplicate gateway payment collapsed by unique index', {
        reservationId, reference: trimmedReference, existingPaymentId: existing.id
      });
      return existing;
    }

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
  },

  // 2026-07-09 (Print Agreement money-fix): exposed so cross-module callers —
  // specifically rental-agreements.service.js#startFromReservation (the Print /
  // Email Agreement path) — can delegate the authoritative agreement recompute
  // to the SAME reconciler every pricing mutation uses. It re-mirrors the
  // reservation charge rows, PRESERVES the FEE_ENGINE_/ADMIN_CORRECTION/
  // DAMAGE_CHARGE carve-out rows, and recomputes subtotal/taxes/fees/total/
  // paidAmount/balance. Keeping money math single-sourced avoids the exact drift
  // this fix removes.
  async syncAgreementCharges(reservationId, scope = {}, opts = {}) {
    return syncAgreementCharges(reservationId, scope, opts);
  }
};
