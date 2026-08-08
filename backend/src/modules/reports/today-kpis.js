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
import { queueWhere } from '../tolls/tolls-queue-counts.js';

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

  const [payments, tollsNeedingReview] = await Promise.all([
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
    // Tolls a HUMAN must judge — the toll module's "Needs review" queue,
    // nothing else.
    //
    // This used to count tolls that were matched but not yet collected.
    // Hector, 2026-08-07: "aun dice 22, cuando le dan no parece nada pq ya
    // todo estan confirmed... entiendo son tolls en reservas que no se han
    // cobrado aun (normal si todo esos contratos estan open)". Exactly right:
    // an open contract's toll rides along and collects itself at check-in. It
    // needed no hands, so a tile you click into and find nothing to do was
    // counting work that does not exist.
    //
    // The definition is IMPORTED from the tolls module rather than restated,
    // so the tile and the queue it links to can never drift — the same reason
    // tolls-queue-counts.js exists at all (the 19-to-21 bug). Rows flagged
    // with no match candidate stay out: they are the 3,390 off-rental ones a
    // human cannot action either.
    //
    // Scoped by the toll's own location the way the tolls module scopes
    // (vehicle home location), NOT the reservation pickup location — a review
    // row often has no reservation yet, which is the whole point of it.
    db.tollTransaction.count({
      where: {
        AND: [
          {
            tenantId,
            staffAckAt: null,
            ...(locationIds ? { vehicle: { is: { homeLocationId: { in: locationIds } } } } : {})
          },
          queueWhere('NEEDS_REVIEW')
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
    // Kept as `pendingTolls` for the existing dashboard contract; the value
    // is now the review queue. `tollsNeedingReview` is the honest name and
    // both are returned so the tile can be relabelled without a flag day.
    pendingTolls: tollsNeedingReview,
    tollsNeedingReview,
    scoped: !!locationIds
  };
}
