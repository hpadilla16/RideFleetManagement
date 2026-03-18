import { prisma } from '../../lib/prisma.js';

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function scopeWhere(scope = {}) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : {};
}

function startOfDay(value) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(value) {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function buildDaySeries(start, end) {
  const out = [];
  const cur = startOfDay(start);
  const stop = startOfDay(end);
  while (cur <= stop) {
    out.push(isoDay(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function sumMoney(rows, field) {
  return Number(
    (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + toNumber(row?.[field]), 0).toFixed(2)
  );
}

export const reportsService = {
  async overview(query = {}, scope = {}) {
    const now = new Date();
    const rawEnd = query?.end ? new Date(query.end) : now;
    const rawStart = query?.start
      ? new Date(query.start)
      : new Date(rawEnd.getTime() - (29 * 24 * 60 * 60 * 1000));

    const start = startOfDay(Number.isNaN(rawStart.getTime()) ? now : rawStart);
    const end = endOfDay(Number.isNaN(rawEnd.getTime()) ? now : rawEnd);
    const whereScope = scopeWhere(scope);

    const [
      reservations,
      reservationPayments,
      agreements,
      vehicles,
      locations
    ] = await Promise.all([
      prisma.reservation.findMany({
        where: { ...whereScope, createdAt: { gte: start, lte: end } },
        select: {
          id: true,
          status: true,
          createdAt: true,
          estimatedTotal: true,
          pickupLocationId: true
        },
        orderBy: { createdAt: 'asc' }
      }),
      prisma.reservationPayment.findMany({
        where: {
          reservation: whereScope,
          status: 'PAID',
          paidAt: { gte: start, lte: end }
        },
        select: {
          id: true,
          amount: true,
          paidAt: true
        },
        orderBy: { paidAt: 'asc' }
      }),
      prisma.rentalAgreement.findMany({
        where: { ...whereScope },
        select: {
          id: true,
          status: true,
          total: true,
          paidAmount: true,
          balance: true,
          createdAt: true,
          closedAt: true
        }
      }),
      prisma.vehicle.findMany({
        where: { ...whereScope },
        select: { id: true, status: true }
      }),
      prisma.location.findMany({
        where: { ...whereScope, isActive: true },
        select: { id: true, name: true }
      })
    ]);

    const reservationsByDayMap = new Map(buildDaySeries(start, end).map((day) => [day, 0]));
    for (const row of reservations) {
      const day = isoDay(row.createdAt);
      reservationsByDayMap.set(day, (reservationsByDayMap.get(day) || 0) + 1);
    }

    const paymentsByDayMap = new Map(buildDaySeries(start, end).map((day) => [day, 0]));
    for (const row of reservationPayments) {
      const day = isoDay(row.paidAt);
      paymentsByDayMap.set(day, Number(((paymentsByDayMap.get(day) || 0) + toNumber(row.amount)).toFixed(2)));
    }

    const reservationStatusCounts = {
      NEW: 0,
      CONFIRMED: 0,
      CHECKED_OUT: 0,
      CHECKED_IN: 0,
      CANCELLED: 0,
      NO_SHOW: 0
    };
    for (const row of reservations) {
      const key = String(row.status || '').toUpperCase();
      if (key in reservationStatusCounts) reservationStatusCounts[key] += 1;
    }

    const activeAgreements = agreements.filter((row) => !['CLOSED', 'CANCELLED'].includes(String(row.status || '').toUpperCase()));
    const closedInRange = agreements.filter((row) => row.closedAt && row.closedAt >= start && row.closedAt <= end);
    const openBalance = Number(activeAgreements.reduce((sum, row) => sum + Math.max(0, toNumber(row.balance)), 0).toFixed(2));
    const fleetTotal = vehicles.filter((row) => String(row.status || '').toUpperCase() !== 'OUT_OF_SERVICE').length;
    const onRent = vehicles.filter((row) => String(row.status || '').toUpperCase() === 'ON_RENT').length;
    const utilizationPct = fleetTotal > 0 ? Number(((onRent / fleetTotal) * 100).toFixed(1)) : 0;

    const locationNameById = new Map(locations.map((row) => [row.id, row.name]));
    const reservationByLocation = Object.entries(
      reservations.reduce((acc, row) => {
        const key = row.pickupLocationId || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {})
    )
      .map(([locationId, count]) => ({
        locationId,
        name: locationNameById.get(locationId) || 'Unknown',
        count
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      range: {
        start: start.toISOString(),
        end: end.toISOString(),
        days: buildDaySeries(start, end).length
      },
      kpis: {
        reservationsCreated: reservations.length,
        checkedOut: reservationStatusCounts.CHECKED_OUT,
        checkedIn: reservationStatusCounts.CHECKED_IN,
        cancelled: reservationStatusCounts.CANCELLED,
        noShow: reservationStatusCounts.NO_SHOW,
        activeAgreements: activeAgreements.length,
        agreementsClosed: closedInRange.length,
        projectedRevenue: sumMoney(reservations, 'estimatedTotal'),
        collectedPayments: sumMoney(reservationPayments, 'amount'),
        openBalance,
        fleetTotal,
        onRent,
        utilizationPct
      },
      reservationStatusBreakdown: Object.entries(reservationStatusCounts).map(([status, count]) => ({ status, count })),
      reservationsByDay: Array.from(reservationsByDayMap.entries()).map(([date, count]) => ({ date, count })),
      paymentsByDay: Array.from(paymentsByDayMap.entries()).map(([date, amount]) => ({ date, amount })),
      topPickupLocations: reservationByLocation
    };
  }
};
