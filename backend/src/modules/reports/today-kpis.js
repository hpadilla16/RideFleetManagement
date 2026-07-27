/**
 * Today-KPIs for the dashboard (2026-07-26, from the approved UI mockups):
 * "Collected today" + "Pending tolls". Money display — the collected sum
 * reuses the CANONICAL collected-payment semantics (collected-payments.js:
 * PAID only, AUTH_HOLD excluded — the exact filter that fixed the $336k vs
 * $47.5k snapshot inflation), and the day boundary is the TENANT timezone
 * (the sales.report 2026-05-26 lesson — never bucket in UTC).
 */
import { prisma } from '../../lib/prisma.js';
import { COLLECTED_PAYMENT_WHERE } from './collected-payments.js';
import { startOfDayInTz, addDaysInTz } from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

export async function computeTodayKpis(tenantId, deps = {}) {
  if (!tenantId) throw new Error('tenantId required');
  const db = deps.prisma || prisma;
  const now = deps.now || new Date();
  const tz = await resolveTenantTimeZone(tenantId);
  const from = startOfDayInTz(now, tz);
  const to = addDaysInTz(from, 1);

  const [collected, pendingTolls] = await Promise.all([
    db.rentalAgreementPayment.aggregate({
      _sum: { amount: true },
      where: {
        rentalAgreement: { tenantId },
        ...COLLECTED_PAYMENT_WHERE,
        paidAt: { gte: from, lt: to }
      }
    }),
    // Mirrors listStaffTollAlerts' where (tolls.service.js): unacknowledged
    // billable tolls attached to a contract — the "someone still has to
    // collect this" number, not raw needs-review noise.
    db.tollTransaction.count({
      where: {
        tenantId,
        staffAckAt: null,
        reservationId: { not: null },
        status: { in: ['MATCHED', 'BILLED'] },
        billingStatus: { in: ['PENDING', 'POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT'] }
      }
    })
  ]);

  return {
    tz,
    from,
    to,
    collectedToday: Number(collected._sum.amount || 0),
    pendingTolls
  };
}
