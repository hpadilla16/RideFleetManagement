import { prisma } from '../../lib/prisma.js';
import { reservationPricingService } from './reservation-pricing.service.js';

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

async function getReservationOrThrow(reservationId, scope = {}) {
  const row = await prisma.reservation.findFirst({
    where: scopedReservationWhere(reservationId, scope),
    include: {
      pricingSnapshot: true,
      charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
    }
  });
  if (!row) throw new Error('Reservation not found');
  return row;
}

async function buildExtensionCharge({
  reservationId,
  extensionDays,
  extensionDailyRate,
  currentDailyRate
}) {
  if (extensionDays <= 0) {
    throw new Error('Extension days must be > 0');
  }

  const rateToUse = extensionDailyRate !== null && extensionDailyRate !== undefined
    ? toNumber(extensionDailyRate)
    : toNumber(currentDailyRate, 0);

  const total = Number((extensionDays * rateToUse).toFixed(2));

  return {
    reservationId,
    code: 'EXTENSION_RATE',
    name: `Extension (${extensionDays} day${extensionDays !== 1 ? 's' : ''} @ $${rateToUse.toFixed(2)}/day)`,
    chargeType: 'DAILY',
    quantity: extensionDays,
    rate: rateToUse,
    total,
    taxable: false,
    selected: true,
    source: extensionDailyRate !== null && extensionDailyRate !== undefined
      ? 'EXTENSION_OVERRIDE'
      : 'EXTENSION_DEFAULT',
    sourceRefId: null,
    sortOrder: 1000,
    notes: null
  };
}

function summarizeChargeTotals(charges = []) {
  const rows = Array.isArray(charges) ? charges : [];
  const subtotal = Number(rows
    .filter((r) => String(r?.chargeType || '').toUpperCase() !== 'TAX')
    .filter((r) => String(r?.source || '').toUpperCase() !== 'SECURITY_DEPOSIT')
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const taxes = Number(rows
    .filter((r) => String(r?.chargeType || '').toUpperCase() === 'TAX')
    .reduce((sum, r) => sum + toNumber(r?.total), 0)
    .toFixed(2));
  const total = Number((subtotal + taxes).toFixed(2));
  return { subtotal, taxes, total };
}

export const reservationExtendService = {
  async extendReservation({
    reservationId,
    newReturnAt,
    extensionDailyRate,
    note,
    actorUserId,
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

    // 2. Load reservation
    const current = await getReservationOrThrow(reservationId, tenantScope);

    const currentReturnDate = new Date(current.returnAt);
    if (nextReturnDate <= currentReturnDate) {
      throw new Error('New return date must be after the current return date');
    }

    // 3. Validate reservation state (not CANCELLED or COMPLETED)
    const reservationStatus = String(current.status || '').toUpperCase();
    const disallowedStates = ['CANCELLED', 'CHECKED_IN'];
    if (disallowedStates.includes(reservationStatus)) {
      throw new Error(`Cannot extend a reservation with status ${current.status}`);
    }

    // 4. Validate extensionDailyRate if provided
    let validatedExtensionDailyRate = null;
    if (extensionDailyRate !== null && extensionDailyRate !== undefined && extensionDailyRate !== '') {
      const rate = toNumber(extensionDailyRate);
      if (rate < 0) {
        throw new Error('extensionDailyRate cannot be negative');
      }
      validatedExtensionDailyRate = rate;
    }

    // 5. Compute extension days
    const extensionDays = rentalDays(current.returnAt, nextReturnDate);

    // 6. Update reservation.returnAt
    const updated = await prisma.reservation.update({
      where: { id: reservationId },
      data: { returnAt: nextReturnDate }
    });

    // 7. Create extension charge
    const extensionCharge = await buildExtensionCharge({
      reservationId,
      extensionDays,
      extensionDailyRate: validatedExtensionDailyRate,
      currentDailyRate: toNumber(current.pricingSnapshot?.dailyRate, toNumber(current.dailyRate))
    });

    const createdCharge = await prisma.reservationCharge.create({
      data: extensionCharge
    });

    // 8. Recompute estimatedTotal with all selected charges
    const allCharges = await prisma.reservationCharge.findMany({
      where: { reservationId, selected: true }
    });

    const { total: newEstimatedTotal } = summarizeChargeTotals(allCharges);

    await prisma.reservation.update({
      where: { id: reservationId },
      data: { estimatedTotal: newEstimatedTotal }
    });

    // 9. Create audit log
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
          extensionDailyRate: validatedExtensionDailyRate,
          extensionChargeId: createdCharge.id,
          note: String(note || '').trim() || null
        })
      }
    });

    // 10. Return updated reservation card
    const final = await prisma.reservation.findFirst({
      where: { id: reservationId },
      include: {
        pricingSnapshot: true,
        charges: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      }
    });

    return {
      reservation: final,
      extensionCharge: createdCharge,
      extensionDays
    };
  }
};
