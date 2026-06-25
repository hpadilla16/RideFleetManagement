import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

/**
 * Long-Term (Monthly) Reservations — P1 (2026-06-03).
 *
 * RULES (per Hector):
 *   • Monthly is EXPLICIT opt-in at creation. A daily reservation that runs
 *     28+ days NEVER auto-converts. The only way a plan exists is attachPlan.
 *   • cycleRate comes from RateItem.monthly (the per-vehicle-type monthly
 *     price already configurable in Settings → Rates) — or an explicit agent
 *     override — and is LOCKED into the plan. Renewals never float.
 *   • Cycle 1 is billed by the normal checkout (the agreement's base charge
 *     becomes "Monthly Cycle 1" — see rental-agreements.service hook).
 *     Later cycles are created by closeNextCycle (P1: staff-triggered;
 *     P2 adds the worker + autocharge + dunning).
 *   • Charges land as source MONTHLY_CYCLE (non-deposit) so the existing
 *     ledger (paid = payments, balance = non-deposit charges − paid) and
 *     receipts work unchanged.
 */

function err(message, statusCode = 400) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function tenantScope(user) {
  return user?.tenantId ? { tenantId: user.tenantId } : {};
}

function round2(n) { return Number(Number(n || 0).toFixed(2)); }

function addDays(d, n) { return new Date(new Date(d).getTime() + n * 24 * 3600e3); }

async function resolveMonthlyRate({ tenantId, rateId, vehicleTypeId }) {
  const where = rateId
    ? { id: String(rateId) }
    : { ...(tenantId ? { tenantId } : {}), isActive: true, active: true };
  const rates = await prisma.rate.findMany({
    where,
    select: {
      id: true, rateCode: true,
      rateItems: { where: { vehicleTypeId: String(vehicleTypeId) }, select: { monthly: true, minMonthly: true } },
    },
    take: rateId ? 1 : 10,
  });
  for (const r of rates) {
    const monthly = Number(r.rateItems?.[0]?.monthly || 0);
    if (monthly > 0) return { rateId: r.id, monthly, minMonthly: Number(r.rateItems?.[0]?.minMonthly || 0) };
  }
  return null;
}

/**
 * Apply monthly pricing to the RESERVATION (2026-06-25). When a plan is attached or its
 * cycleRate changes, the rental base on the reservation becomes ONE locked "Monthly Cycle 1"
 * line = cycleRate (Option B — exact monthly rate, not days x dailyRate), and the Sales Tax is
 * recomputed on the new taxable base. This mirrors the finalize hook in rental-agreements
 * (Monthly Cycle 1 / source MONTHLY_CYCLE, line ~2181) so the reservation pricing, the agreement
 * balance and the checkout all agree — fixing the case where the panel showed days x dailyRate
 * ($1,624.20) while the plan was $950. getPricing/syncAgreementCharges rebuild the agreement from
 * these ReservationCharge rows, so the unpaid balance follows automatically.
 */
async function applyMonthlyPricing(reservationId, cycleRate, scope = {}) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: String(reservationId) },
    select: { id: true, pickupLocation: { select: { taxRate: true } } },
  });
  if (!reservation) return;
  const rate = round2(cycleRate);

  // Replace the rental base line (Daily / BASE_RATE) — and any prior monthly line — with a
  // single locked Monthly Cycle 1 charge. Other lines (services, fees, insurance) are untouched.
  // Match the rental base line across all creation flows (public booking sets source
  // BASE_RATE/code DAILY; staff flows label it "Daily"). We do NOT match by chargeType
  // alone (a per-day SERVICE is chargeType DAILY) to avoid nuking add-ons.
  await prisma.reservationCharge.deleteMany({
    where: {
      reservationId,
      OR: [{ source: 'BASE_RATE' }, { source: 'MONTHLY_CYCLE' }, { code: 'DAILY' }, { name: 'Daily' }],
    },
  });
  await prisma.reservationCharge.create({
    data: {
      reservationId, code: 'MONTHLY', name: 'Monthly Cycle 1', chargeType: 'MONTHLY',
      quantity: 1, rate, total: rate, taxable: true, selected: true, sortOrder: 0,
      source: 'MONTHLY_CYCLE',
    },
  });

  // Recompute Sales Tax on the new taxable base (all selected, taxable, non-TAX charges).
  const taxRate = Number(reservation.pickupLocation?.taxRate || 0);
  const charges = await prisma.reservationCharge.findMany({ where: { reservationId, selected: true } });
  const taxableBase = charges
    .filter((c) => c.taxable && String(c.chargeType || '').toUpperCase() !== 'TAX' && String(c.source || '').toUpperCase() !== 'TAX')
    .reduce((s, c) => s + Number(c.total || 0), 0);
  const taxTotal = round2(taxableBase * (taxRate / 100));
  const existingTax = charges.find((c) => String(c.source || '').toUpperCase() === 'TAX' || String(c.code || '').toUpperCase() === 'TAX');
  if (existingTax) {
    if (taxTotal > 0) {
      await prisma.reservationCharge.update({ where: { id: existingTax.id }, data: { rate: taxTotal, total: taxTotal, name: `Sales Tax (${taxRate.toFixed(2)}%)` } });
    } else {
      await prisma.reservationCharge.delete({ where: { id: existingTax.id } });
    }
  } else if (taxTotal > 0) {
    const maxSort = charges.reduce((m, c) => Math.max(m, Number(c.sortOrder || 0)), 0);
    await prisma.reservationCharge.create({
      data: { reservationId, code: 'TAX', name: `Sales Tax (${taxRate.toFixed(2)}%)`, chargeType: 'TAX', quantity: 1, rate: taxTotal, total: taxTotal, taxable: false, selected: true, sortOrder: maxSort + 1, source: 'TAX' },
    });
  }

  // estimatedTotal = selected non-deposit charges (incl. tax). Deposits are held separately.
  const refreshed = await prisma.reservationCharge.findMany({ where: { reservationId, selected: true } });
  const estimatedTotal = round2(
    refreshed
      .filter((c) => String(c.source || '').toUpperCase() !== 'DEPOSIT' && String(c.chargeType || '').toUpperCase() !== 'DEPOSIT')
      .reduce((s, c) => s + Number(c.total || 0), 0)
  );
  await prisma.reservation.update({ where: { id: reservationId }, data: { estimatedTotal } });

  // Propagate to the agreement (if one exists) so the unpaid balance matches immediately.
  // Dynamic import avoids a load-time circular dependency with the pricing service.
  try {
    const { reservationPricingService } = await import('../reservations/reservation-pricing.service.js');
    await reservationPricingService.getPricing(reservationId, scope, { allowClosed: true });
  } catch (e) {
    logger.warn(`applyMonthlyPricing: agreement recompute skipped: ${String(e?.message || e)}`);
  }
}

export const longTermService = {
  /** Attach a monthly plan to a reservation (the explicit opt-in). */
  async attachPlan(user, reservationId, payload = {}) {
    const reservation = await prisma.reservation.findFirst({
      where: { id: String(reservationId), ...tenantScope(user) },
      select: { id: true, tenantId: true, vehicleTypeId: true, pickupAt: true, status: true },
    });
    if (!reservation) throw err('Reservation not found', 404);
    const existing = await prisma.longTermPlan.findUnique({ where: { reservationId: reservation.id } });
    if (existing) throw err('Reservation already has a long-term plan', 409);

    const cycleLengthDays = Math.max(1, Number(payload.cycleLengthDays || 30));
    let cycleRate = Number(payload.cycleRate || 0);
    let rateId = payload.rateId ? String(payload.rateId) : null;
    if (!(cycleRate > 0)) {
      if (!reservation.vehicleTypeId) throw err('Reservation needs a vehicle type to resolve the monthly rate', 422);
      const resolved = await resolveMonthlyRate({
        tenantId: reservation.tenantId, rateId, vehicleTypeId: reservation.vehicleTypeId,
      });
      if (!resolved) throw err('No monthly rate configured for this vehicle type (Settings → Rates → Monthly)', 422);
      cycleRate = resolved.monthly;
      rateId = resolved.rateId;
    }

    const periodStart = reservation.pickupAt || new Date();
    const plan = await prisma.longTermPlan.create({
      data: {
        tenantId: reservation.tenantId,
        reservationId: reservation.id,
        rateId,
        cycleLengthDays,
        cycleRate: round2(cycleRate),
        includedMilesPerCycle: payload.includedMilesPerCycle != null ? Number(payload.includedMilesPerCycle) : 3000,
        overagePerMile: payload.overagePerMile != null ? round2(payload.overagePerMile) : 0,
        autoRenew: payload.autoRenew !== false,
        nextCycleStartsAt: addDays(periodStart, cycleLengthDays),
        billingCycles: {
          create: {
            cycleNumber: 1,
            periodStart,
            periodEnd: addDays(periodStart, cycleLengthDays),
            amount: round2(cycleRate),
            status: 'DUE', // becomes PAID when the checkout sale settles (staff marks, or P2 auto)
          },
        },
      },
      include: { billingCycles: true },
    });
    await prisma.auditLog.create({
      data: {
        tenantId: reservation.tenantId, reservationId: reservation.id,
        actorUserId: user?.id || null, action: 'UPDATE',
        reason: `Long-term plan attached · $${plan.cycleRate}/${cycleLengthDays}d`,
        metadata: JSON.stringify({ longTermPlanId: plan.id, cycleRate: String(plan.cycleRate), cycleLengthDays }),
      },
    }).catch(() => {});
    // Reprice the reservation NOW so the panel + unpaid balance show the locked monthly rate
    // (one "Monthly Cycle 1" line + recomputed tax) instead of days x dailyRate.
    await applyMonthlyPricing(reservation.id, plan.cycleRate, { tenantId: reservation.tenantId });
    return plan;
  },

  async getPlanByReservation(user, reservationId) {
    return prisma.longTermPlan.findFirst({
      where: { reservationId: String(reservationId), ...tenantScope(user) },
      include: { billingCycles: { orderBy: { cycleNumber: 'desc' } } },
    });
  },

  /** Patch autoRenew / status / cycleRate / mileage policy. */
  async updatePlan(user, planId, payload = {}) {
    const plan = await prisma.longTermPlan.findFirst({ where: { id: String(planId), ...tenantScope(user) } });
    if (!plan) throw err('Plan not found', 404);
    const data = {};
    if ('autoRenew' in payload) data.autoRenew = !!payload.autoRenew;
    if ('cycleRate' in payload && Number(payload.cycleRate) > 0) data.cycleRate = round2(payload.cycleRate);
    if ('includedMilesPerCycle' in payload) data.includedMilesPerCycle = payload.includedMilesPerCycle == null ? null : Number(payload.includedMilesPerCycle);
    if ('overagePerMile' in payload) data.overagePerMile = round2(payload.overagePerMile);
    if ('status' in payload && ['ACTIVE', 'PAUSED', 'ENDED'].includes(String(payload.status))) {
      data.status = String(payload.status);
      if (data.status === 'ENDED') { data.endedAt = new Date(); data.autoRenew = false; }
    }
    const updated = await prisma.longTermPlan.update({ where: { id: plan.id }, data, include: { billingCycles: { orderBy: { cycleNumber: 'desc' } } } });
    // If the locked monthly rate changed, re-apply the single Monthly Cycle 1 line + tax.
    if ('cycleRate' in data) {
      await applyMonthlyPricing(plan.reservationId, data.cycleRate, { tenantId: plan.tenantId });
    }
    return updated;
  },

  /**
   * Close/bill the next cycle (P1: staff-triggered from the plan panel).
   * Creates the MONTHLY_CYCLE charge on the agreement, recomputes agreement
   * totals at the agreement's own tax rate, extends returnAt to the new
   * period end, creates the BillingCycle row, and advances the plan clock.
   * Payment is then collected via the existing View Payments rails.
   */
  async closeNextCycle(user, planId, payload = {}) {
    const plan = await prisma.longTermPlan.findFirst({
      where: { id: String(planId), ...tenantScope(user) },
      include: { billingCycles: { orderBy: { cycleNumber: 'desc' }, take: 1 } },
    });
    if (!plan) throw err('Plan not found', 404);
    if (plan.status !== 'ACTIVE') throw err(`Plan is ${plan.status} — reactivate before billing`, 409);

    const agreement = await prisma.rentalAgreement.findFirst({
      where: { reservationId: plan.reservationId },
      select: { id: true, subtotal: true, taxes: true, total: true, paidAmount: true },
    });
    if (!agreement) throw err('No rental agreement yet — complete checkout before billing cycles', 409);

    const lastNumber = plan.billingCycles[0]?.cycleNumber || 0;
    const cycleNumber = lastNumber + 1;
    const periodStart = plan.nextCycleStartsAt;
    const periodEnd = addDays(periodStart, plan.cycleLengthDays);

    // Mileage overage (P1: from payload if staff enters miles; telematics in P3)
    const overageMiles = Math.max(0, Number(payload.overageMiles || 0));
    const overageAmount = round2(overageMiles * Number(plan.overagePerMile || 0));
    const amount = round2(Number(plan.cycleRate) + overageAmount);

    // Derive the agreement's effective tax rate from its own stored ratio so
    // the cycle line taxes exactly like the original charges.
    const subtotal0 = Number(agreement.subtotal || 0);
    const taxRate = subtotal0 > 0 ? Number(agreement.taxes || 0) / subtotal0 : 0;

    const charge = await prisma.rentalAgreementCharge.create({
      data: {
        rentalAgreementId: agreement.id,
        name: `Monthly Cycle ${cycleNumber}`,
        chargeType: 'MONTHLY',
        quantity: 1,
        rate: amount,
        total: amount,
        taxable: true,
        selected: true,
        sortOrder: 100 + cycleNumber,
        source: 'MONTHLY_CYCLE',
      },
    });

    const newSubtotal = round2(subtotal0 + amount);
    const newTaxes = round2(Number(agreement.taxes || 0) + amount * taxRate);
    const newTotal = round2(newSubtotal + newTaxes);
    await prisma.rentalAgreement.update({
      where: { id: agreement.id },
      data: {
        subtotal: newSubtotal,
        taxes: newTaxes,
        total: newTotal,
        balance: round2(Math.max(0, newTotal - Number(agreement.paidAmount || 0))),
      },
    });

    const [cycle] = await prisma.$transaction([
      prisma.billingCycle.create({
        data: {
          longTermPlanId: plan.id, cycleNumber, periodStart, periodEnd,
          amount: round2(amount + round2(amount * taxRate)),
          overageMiles, status: 'DUE', chargeId: charge.id,
          milesStart: payload.milesStart != null ? Number(payload.milesStart) : null,
          milesEnd: payload.milesEnd != null ? Number(payload.milesEnd) : null,
        },
      }),
      prisma.longTermPlan.update({ where: { id: plan.id }, data: { nextCycleStartsAt: periodEnd } }),
      // Auto-extend the reservation to cover the newly billed period.
      prisma.reservation.update({ where: { id: plan.reservationId }, data: { returnAt: periodEnd } }),
    ]);

    logger.info('[long-term] cycle billed', {
      planId: plan.id, reservationId: plan.reservationId, cycleNumber, amount, overageMiles,
    });
    return { cycle, chargeId: charge.id, agreementTotals: { subtotal: newSubtotal, taxes: newTaxes, total: newTotal } };
  },

  /** Mark a cycle paid (payment itself recorded via View Payments rails). */
  async markCyclePaid(user, cycleId, payload = {}) {
    const cycle = await prisma.billingCycle.findFirst({
      where: { id: String(cycleId), longTermPlan: { ...tenantScope(user) } },
    });
    if (!cycle) throw err('Billing cycle not found', 404);
    return prisma.billingCycle.update({
      where: { id: cycle.id },
      data: { status: 'PAID', paidAt: new Date(), paymentId: payload.paymentId ? String(payload.paymentId) : cycle.paymentId },
    });
  },

  /** Lightweight list for the reservations page filter / dashboards. */
  async listPlans(user, { status, dueBefore } = {}) {
    return prisma.longTermPlan.findMany({
      where: {
        ...tenantScope(user),
        ...(status ? { status: String(status) } : {}),
        ...(dueBefore ? { nextCycleStartsAt: { lte: new Date(dueBefore) } } : {}),
      },
      include: {
        billingCycles: { orderBy: { cycleNumber: 'desc' }, take: 1 },
        reservation: { select: { id: true, reservationNumber: true, status: true, returnAt: true } },
      },
      orderBy: { nextCycleStartsAt: 'asc' },
      take: 200,
    });
  },
};
