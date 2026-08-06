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

/**
 * @param {object} deps
 * @param {string[]|null} [deps.locationIds] — a LOCATION-SCOPED user's allowed
 *        locations (2026-08-06, Hector: the tile splits by location and every
 *        user can see it). null = tenant-wide. Payments attach to a location
 *        through the agreement's reservation pickup location.
 */
export async function computeTodayKpis(tenantId, deps = {}) {
  if (!tenantId) throw new Error('tenantId required');
  const db = deps.prisma || prisma;
  const now = deps.now || new Date();
  const locationIds = Array.isArray(deps.locationIds) && deps.locationIds.length ? deps.locationIds : null;
  const tz = await resolveTenantTimeZone(tenantId);
  const from = startOfDayInTz(now, tz);
  const to = addDaysInTz(from, 1);

  const locationScope = locationIds
    ? { reservation: { pickupLocationId: { in: locationIds } } }
    : {};

  const [payments, pendingTolls] = await Promise.all([
    // Row-level (not aggregate) so the sum can split per pickup location. A
    // day's collected payments are tens of rows, not thousands.
    db.rentalAgreementPayment.findMany({
      where: {
        rentalAgreement: { tenantId, ...locationScope },
        ...COLLECTED_PAYMENT_WHERE,
        paidAt: { gte: from, lt: to }
      },
      select: {
        amount: true,
        rentalAgreement: {
          select: {
            reservation: {
              select: { pickupLocation: { select: { id: true, code: true, name: true } } }
            }
          }
        }
      }
    }),
    // "Someone still has to ACT on this" — and nothing else (Hector,
    // 2026-08-06: the tile read 186/380 when the real answer was 60/0).
    // A toll POSTED to a reservation or agreement is already on the
    // customer's bill and collects itself with the contract — counting it
    // as pending inflated the tile with money that needed no hands. What
    // is actionable:
    //   - billingStatus PENDING: matched + billable but not yet posted;
    //   - POSTED_* whose agreement is already CLOSED: the contract settled
    //     without it, so collection is manual (the [CONTRATO CERRADO]
    //     emails flag the same rows).
    // staffAckAt still counts as "handled" (years of rows were dismissed
    // with the old button — dropping it resurrected 1,032 of them), and the
    // closed-contract branch clears itself by MONEY, not by clicks: once the
    // manual collection posts and the agreement balance reaches zero, the
    // toll stops counting. No button needed, nothing grows forever.
    db.tollTransaction.count({
      where: {
        tenantId,
        staffAckAt: null,
        reservationId: { not: null },
        ...(locationIds ? { reservation: { pickupLocationId: { in: locationIds } } } : {}),
        status: { in: ['MATCHED', 'BILLED'] },
        OR: [
          { billingStatus: 'PENDING' },
          {
            billingStatus: { in: ['POSTED_TO_RESERVATION', 'POSTED_TO_AGREEMENT'] },
            reservation: {
              ...(locationIds ? { pickupLocationId: { in: locationIds } } : {}),
              rentalAgreement: { status: 'CLOSED', balance: { gt: 0 } }
            }
          }
        ]
      }
    })
  ]);

  let collectedToday = 0;
  const byLocationMap = new Map();
  for (const p of payments) {
    const amount = Number(p.amount || 0);
    collectedToday += amount;
    const loc = p.rentalAgreement?.reservation?.pickupLocation || null;
    const key = loc?.id || 'none';
    if (!byLocationMap.has(key)) {
      byLocationMap.set(key, {
        locationId: loc?.id || null,
        code: loc?.code || null,
        name: loc?.name || null,
        amount: 0
      });
    }
    byLocationMap.get(key).amount += amount;
  }
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const byLocation = [...byLocationMap.values()]
    .map((row) => ({ ...row, amount: round2(row.amount) }))
    .sort((a, b) => b.amount - a.amount);

  return {
    tz,
    from,
    to,
    collectedToday: round2(collectedToday),
    byLocation,
    pendingTolls,
    scoped: !!locationIds
  };
}
