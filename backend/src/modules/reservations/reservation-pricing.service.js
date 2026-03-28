import { prisma } from '../../lib/prisma.js';
import { tollsService } from '../tolls/tolls.service.js';

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
  return ['CASH', 'CARD', 'ZELLE', 'ATH_MOVIL', 'BANK_TRANSFER', 'OTHER'].includes(raw) ? raw : 'OTHER';
}

function normalizePaymentOrigin(origin) {
  const raw = String(origin || '').trim().toUpperCase();
  if (!raw) return 'OTC';
  return ['OTC', 'PORTAL', 'IMPORTED', 'MIGRATED_NOTE'].includes(raw) ? raw : 'OTC';
}

function scopedReservationWhere(id, scope = {}) {
  return { id, ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) };
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

function summarizeChargeTotals(charges = []) {
  const rows = Array.isArray(charges) ? charges : [];
  const subtotal = Number(rows
    .filter((r) => String(r?.chargeType || '').toUpperCase() !== 'TAX')
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const taxes = Number(rows
    .filter((r) => String(r?.chargeType || '').toUpperCase() === 'TAX')
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const total = Number((subtotal + taxes).toFixed(2));
  return { subtotal, taxes, total };
}

async function syncAgreementCharges(reservationId, scope = {}) {
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
  if (['CLOSED', 'CANCELLED'].includes(String(agreement.status || '').toUpperCase())) return null;

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
  const { subtotal, taxes, total } = summarizeChargeTotals(chargeRows);
  const paidAmount = toNumber(agreement.paidAmount);
  const balance = Number((total - paidAmount).toFixed(2));

  await prisma.rentalAgreementCharge.deleteMany({ where: { rentalAgreementId: agreement.id } });
  if (chargeRows.length) {
    await prisma.rentalAgreementCharge.createMany({ data: chargeRows });
  }

  await prisma.rentalAgreement.update({
    where: { id: agreement.id },
    data: { subtotal, taxes, total, balance }
  });

  return { agreementId: agreement.id, subtotal, taxes, total, balance };
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

  const paidAmount = Number((toNumber(agreement.paidAmount) + toNumber(payment.amount)).toFixed(2));
  const balance = Number((toNumber(agreement.total) - paidAmount).toFixed(2));
  await prisma.rentalAgreement.update({
    where: { id: agreement.id },
    data: { paidAmount, balance }
  });

  return created;
}

export const reservationPricingService = {
  async getPricing(reservationId, scope = {}) {
    await tollsService.syncReservationCharges(reservationId, scope);
    await syncAgreementCharges(reservationId, scope);
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
    const chargeRows = buildChargeRows(reservationId, payload.charges || []);

    await prisma.$transaction(async (tx) => {
      await tx.reservationPricingSnapshot.upsert({
        where: { reservationId },
        create: { reservationId, ...snapshotData },
        update: snapshotData
      });

      await tx.reservationCharge.deleteMany({ where: { reservationId } });
      if (chargeRows.length) {
        await tx.reservationCharge.createMany({ data: chargeRows });
      }

      const nextDailyRate = snapshotData.dailyRate;
      const estimatedTotal = summarizeChargeTotals(chargeRows).total;
      await tx.reservation.update({
        where: { id: reservationId },
        data: {
          dailyRate: nextDailyRate,
          estimatedTotal
        }
      });
    });

    await tollsService.syncReservationCharges(reservationId, scope);
    await syncAgreementCharges(reservationId, scope);
    return this.getPricing(reservationId, scope);
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

    const paymentData = {
      reservationId,
      method: normalizePaymentMethod(payload.method),
      amount,
      reference: payload.reference ? String(payload.reference).trim() : null,
      status: String(payload.status || 'PAID').trim().toUpperCase(),
      paidAt,
      origin: normalizePaymentOrigin(payload.origin),
      gateway: payload.gateway ? String(payload.gateway).trim() : null,
      notes: payload.notes ? String(payload.notes) : null
    };

    const created = await prisma.reservationPayment.create({ data: paymentData });
    const agreementPayment = await maybeCreateAgreementPayment({ reservation, payment: created });

    if (agreementPayment?.id) {
      await prisma.reservationPayment.update({
        where: { id: created.id },
        data: { rentalAgreementPaymentId: agreementPayment.id }
      });
    }

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

    return prisma.reservationPayment.findUnique({ where: { id: created.id } });
  }
};
