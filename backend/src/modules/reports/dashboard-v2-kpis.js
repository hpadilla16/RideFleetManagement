/**
 * Dashboard v2 hero KPIs (2026-08-03, phase 4-5 of design/DASHBOARD-V2.md).
 *
 * Three numbers, matching the marketing product shot:
 *   - Turn-Ready: fleet-wide status counts + average score. Computed through
 *     the same buildVehicleOperationalSignalsMap the planner and the vehicle
 *     profile use — the dashboard must agree with the screens it links to,
 *     so there is deliberately no second scoring path here.
 *   - Utilization: reserved vehicle-days / fleet capacity over the trailing
 *     7 days, plus the same for the 7 days before that for the week-over-week
 *     delta. Day boundaries in the TENANT timezone (sales.report 2026-05-26
 *     lesson — never bucket in UTC).
 *   - Tolls reconciled, 30d: crossings matched to a booking (the money that
 *     did NOT leak), and the current needs-review count as the friction
 *     number. "Reconciled" = attached to a reservation, whatever its billing
 *     stage — attribution is the hard part this measures.
 *
 * Location-scoped users get the fleet slice their homeLocationId allows —
 * same posture as the planner.
 */
import { prisma } from '../../lib/prisma.js';
import { buildVehicleOperationalSignalsMap } from '../vehicles/vehicle-intelligence.service.js';
import { startOfDayInTz, addDaysInTz } from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

const DAY_MS = 86400000;

function activeAvailabilityBlock(blocks = [], now = new Date()) {
  const nowValue = now.getTime();
  return blocks.find((block) => {
    const releasedAt = block?.releasedAt ? new Date(block.releasedAt).getTime() : null;
    const blockedFrom = block?.blockedFrom ? new Date(block.blockedFrom).getTime() : nowValue;
    const availableFrom = block?.availableFrom ? new Date(block.availableFrom).getTime() : null;
    return !releasedAt && blockedFrom <= nowValue && availableFrom && availableFrom > nowValue;
  }) || null;
}

/**
 * Reserved vehicle-days over [from, to) divided by fleet-size * window-days.
 * Overlap is clipped per reservation, so a month-long rental only contributes
 * the days that fall inside the window.
 */
function utilizationPct(reservations, fleetCount, from, to) {
  const windowMs = to.getTime() - from.getTime();
  const capacityDays = fleetCount * (windowMs / DAY_MS);
  if (capacityDays <= 0) return null;
  let reservedMs = 0;
  for (const r of reservations) {
    const a = Math.max(new Date(r.pickupAt).getTime(), from.getTime());
    const b = Math.min(new Date(r.returnAt).getTime(), to.getTime());
    if (b > a) reservedMs += b - a;
  }
  return Math.min(100, (reservedMs / DAY_MS / capacityDays) * 100);
}

export async function computeDashboardV2Kpis(tenantId, { allowedLocationIds = null, now = new Date(), deps = {} } = {}) {
  if (!tenantId) throw new Error('tenantId required');
  const db = deps.prisma || prisma;
  const signalsMap = deps.buildVehicleOperationalSignalsMap || buildVehicleOperationalSignalsMap;

  const tz = await resolveTenantTimeZone(tenantId);
  const today = startOfDayInTz(now, tz);
  const weekFrom = addDaysInTz(today, -7);
  const prevWeekFrom = addDaysInTz(today, -14);
  const thirtyFrom = addDaysInTz(today, -30);

  const locationFilter = Array.isArray(allowedLocationIds) && allowedLocationIds.length
    ? { homeLocationId: { in: allowedLocationIds } }
    : {};

  const vehicles = await db.vehicle.findMany({
    where: { tenantId, status: { not: 'RETIRED' }, ...locationFilter },
    select: {
      id: true,
      availabilityBlocks: {
        where: { releasedAt: null },
        select: { blockType: true, blockedFrom: true, availableFrom: true, releasedAt: true }
      }
    }
  });
  const vehicleIds = vehicles.map((v) => v.id);

  const activeBlocksByVehicleId = new Map(
    vehicles
      .map((v) => [v.id, activeAvailabilityBlock(v.availabilityBlocks, now)])
      .filter(([, block]) => !!block)
  );

  const [signals, weekReservations, tollsAgg, tollsInReview] = await Promise.all([
    signalsMap(vehicleIds, { tenantId }, { activeBlocksByVehicleId }),
    // One query covers both weeks; utilizationPct clips per window.
    db.reservation.findMany({
      where: {
        tenantId,
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
        pickupAt: { lt: today },
        returnAt: { gt: prevWeekFrom },
        ...(vehicleIds.length ? { vehicleId: { in: vehicleIds } } : {})
      },
      select: { pickupAt: true, returnAt: true }
    }),
    db.tollTransaction.aggregate({
      _sum: { amount: true },
      _count: { _all: true },
      where: {
        tenantId,
        reservationId: { not: null },
        transactionAt: { gte: thirtyFrom, lt: today }
      }
    }),
    db.tollTransaction.count({
      where: { tenantId, needsReview: true }
    })
  ]);

  const counts = { READY: 0, WATCH: 0, ATTENTION: 0, BLOCKED: 0 };
  let scoreSum = 0;
  let scored = 0;
  for (const id of vehicleIds) {
    const turnReady = signals.get(id)?.turnReady;
    if (!turnReady) continue;
    const status = String(turnReady.status || '').toUpperCase();
    if (status in counts) counts[status] += 1;
    if (Number.isFinite(Number(turnReady.score))) { scoreSum += Number(turnReady.score); scored += 1; }
  }

  const thisWeek = utilizationPct(weekReservations, vehicles.length, weekFrom, today);
  const prevWeek = utilizationPct(weekReservations, vehicles.length, prevWeekFrom, weekFrom);

  return {
    tz,
    asOf: now.toISOString(),
    fleetCount: vehicles.length,
    turnReady: {
      avgScore: scored ? Math.round(scoreSum / scored) : null,
      ready: counts.READY,
      watch: counts.WATCH,
      attention: counts.ATTENTION,
      blocked: counts.BLOCKED,
      scored
    },
    utilization: {
      pct: thisWeek == null ? null : +thisWeek.toFixed(1),
      prevPct: prevWeek == null ? null : +prevWeek.toFixed(1),
      deltaPts: thisWeek == null || prevWeek == null ? null : +(thisWeek - prevWeek).toFixed(1)
    },
    tolls30d: {
      reconciledAmount: Number(tollsAgg._sum.amount || 0),
      crossings: tollsAgg._count._all,
      inReview: tollsInReview
    }
  };
}
