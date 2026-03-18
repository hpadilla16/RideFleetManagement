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

function csvCell(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function csvLine(values = []) {
  return values.map(csvCell).join(',');
}

function normalizeLocationId(query = {}) {
  const raw = String(query?.locationId || '').trim();
  return raw || null;
}

function normalizeTenantId(query = {}) {
  const raw = String(query?.tenantId || '').trim();
  return raw || null;
}

function normalizeEmployeeUserId(query = {}) {
  const raw = String(query?.employeeUserId || '').trim();
  return raw || null;
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
    const effectiveTenantId = scope?.tenantId || normalizeTenantId(query);
    const whereScope = scopeWhere({ tenantId: effectiveTenantId });
    const locationId = normalizeLocationId(query);
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const reservationWhere = {
      ...whereScope,
      ...(locationId ? { pickupLocationId: locationId } : {}),
      createdAt: { gte: start, lte: end }
    };
    const agreementWhere = {
      ...whereScope,
      ...(locationId ? { pickupLocationId: locationId } : {})
    };
    const vehicleWhere = {
      ...whereScope,
      ...(locationId ? { homeLocationId: locationId } : {})
    };
    const paymentWhere = {
      reservation: {
        ...whereScope,
        ...(locationId ? { pickupLocationId: locationId } : {})
      },
      status: 'PAID',
      paidAt: { gte: start, lte: end }
    };
    const dueTodayWhere = {
      ...whereScope,
      ...(locationId ? { pickupLocationId: locationId } : {}),
      status: { notIn: ['CLOSED', 'CANCELLED'] },
      returnAt: { gte: todayStart, lte: todayEnd }
    };
    const maintenanceWhere = {
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      vehicle: {
        ...whereScope,
        ...(locationId ? { homeLocationId: locationId } : {})
      }
    };

    const [
      reservations,
      reservationPayments,
      agreements,
      vehicles,
      locations,
      tenants,
      dueTodayCount,
      maintenanceJobs
    ] = await Promise.all([
      prisma.reservation.findMany({
        where: reservationWhere,
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
        where: paymentWhere,
        select: {
          id: true,
          amount: true,
          paidAt: true
        },
        orderBy: { paidAt: 'asc' }
      }),
      prisma.rentalAgreement.findMany({
        where: agreementWhere,
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
        where: vehicleWhere,
        select: { id: true, status: true }
      }),
      prisma.location.findMany({
        where: { ...whereScope, isActive: true },
        select: { id: true, name: true }
      }),
      scope?.tenantId
        ? Promise.resolve([])
        : prisma.tenant.findMany({
            orderBy: { name: 'asc' },
            select: { id: true, name: true, status: true }
          }),
      prisma.rentalAgreement.count({
        where: dueTodayWhere
      }),
      prisma.maintenanceJob.findMany({
        where: maintenanceWhere,
        select: { vehicleId: true }
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
    const vehicleMaintenanceCount = vehicles.filter((row) => String(row.status || '').toUpperCase() === 'IN_MAINTENANCE').length;
    const jobVehicleCount = new Set((maintenanceJobs || []).map((row) => row.vehicleId).filter(Boolean)).size;
    const vehiclesInMaintenance = Math.max(vehicleMaintenanceCount, jobVehicleCount);
    const utilizationPct = fleetTotal > 0 ? Number(((onRent / fleetTotal) * 100).toFixed(1)) : 0;

    const locationNameById = new Map(locations.map((row) => [row.id, row.name]));
    const tenantNameById = new Map((tenants || []).map((row) => [row.id, row.name]));
    const selectedLocation = locationId
      ? { id: locationId, name: locationNameById.get(locationId) || 'Unknown' }
      : null;
    const selectedTenant = effectiveTenantId
      ? { id: effectiveTenantId, name: tenantNameById.get(effectiveTenantId) || 'Current Tenant' }
      : null;
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
      filters: {
        tenantId: effectiveTenantId,
        tenantName: selectedTenant?.name || null,
        locationId,
        locationName: selectedLocation?.name || null
      },
      locations,
      tenants,
      kpis: {
        reservationsCreated: reservations.length,
        checkedOut: reservationStatusCounts.CHECKED_OUT,
        checkedIn: reservationStatusCounts.CHECKED_IN,
        cancelled: reservationStatusCounts.CANCELLED,
        noShow: reservationStatusCounts.NO_SHOW,
        activeAgreements: activeAgreements.length,
        agreementsClosed: closedInRange.length,
        agreementsDueToday: dueTodayCount,
        projectedRevenue: sumMoney(reservations, 'estimatedTotal'),
        collectedPayments: sumMoney(reservationPayments, 'amount'),
        openBalance,
        fleetTotal,
        onRent,
        vehiclesInMaintenance,
        utilizationPct
      },
      reservationStatusBreakdown: Object.entries(reservationStatusCounts).map(([status, count]) => ({ status, count })),
      reservationsByDay: Array.from(reservationsByDayMap.entries()).map(([date, count]) => ({ date, count })),
      paymentsByDay: Array.from(paymentsByDayMap.entries()).map(([date, amount]) => ({ date, amount })),
      topPickupLocations: reservationByLocation
    };
  },

  async overviewCsv(query = {}, scope = {}) {
    const report = await this.overview(query, scope);
    const lines = [];

    lines.push(csvLine(['Report', 'Reports Overview v1']));
    lines.push(csvLine(['Start', report.range.start]));
    lines.push(csvLine(['End', report.range.end]));
    lines.push(csvLine(['Days', report.range.days]));
    lines.push(csvLine(['Tenant', report.filters?.tenantName || 'All Tenants']));
    lines.push(csvLine(['Location', report.filters?.locationName || 'All Locations']));
    lines.push('');

    lines.push(csvLine(['KPI', 'Value']));
    for (const [key, value] of Object.entries(report.kpis || {})) {
      lines.push(csvLine([key, value]));
    }
    lines.push('');

    lines.push(csvLine(['Reservation Status', 'Count']));
    for (const row of report.reservationStatusBreakdown || []) {
      lines.push(csvLine([row.status, row.count]));
    }
    lines.push('');

    lines.push(csvLine(['Reservations By Day', 'Count']));
    for (const row of report.reservationsByDay || []) {
      lines.push(csvLine([row.date, row.count]));
    }
    lines.push('');

    lines.push(csvLine(['Payments By Day', 'Amount']));
    for (const row of report.paymentsByDay || []) {
      lines.push(csvLine([row.date, row.amount]));
    }
    lines.push('');

    lines.push(csvLine(['Top Pickup Locations', 'Reservations']));
    for (const row of report.topPickupLocations || []) {
      lines.push(csvLine([row.name, row.count]));
    }

    return lines.join('\n');
  },

  async servicesSold(query = {}, scope = {}) {
    const now = new Date();
    const rawEnd = query?.end ? new Date(query.end) : now;
    const rawStart = query?.start
      ? new Date(query.start)
      : new Date(rawEnd.getTime() - (29 * 24 * 60 * 60 * 1000));

    const start = startOfDay(Number.isNaN(rawStart.getTime()) ? now : rawStart);
    const end = endOfDay(Number.isNaN(rawEnd.getTime()) ? now : rawEnd);
    const effectiveTenantId = scope?.tenantId || normalizeTenantId(query);
    const whereScope = scopeWhere({ tenantId: effectiveTenantId });
    const locationId = normalizeLocationId(query);
    const employeeUserId = normalizeEmployeeUserId(query);

    const lineWhere = {
      agreementCommission: {
        ...whereScope,
        ...(employeeUserId ? { employeeUserId } : {}),
        calculatedAt: { gte: start, lte: end },
        rentalAgreement: {
          ...(locationId ? { pickupLocationId: locationId } : {})
        }
      },
      serviceId: { not: null }
    };

    const [lines, locations, tenants, employees] = await Promise.all([
      prisma.agreementCommissionLine.findMany({
        where: lineWhere,
        include: {
          service: { select: { id: true, name: true, code: true } },
          agreementCommission: {
            select: {
              id: true,
              tenantId: true,
              employeeUserId: true,
              commissionAmount: true,
              rentalAgreement: {
                select: {
                  id: true,
                  agreementNumber: true,
                  pickupLocationId: true,
                  closedAt: true
                }
              },
              employeeUser: {
                select: {
                  id: true,
                  fullName: true,
                  email: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.location.findMany({
        where: { ...whereScope, isActive: true },
        select: { id: true, name: true }
      }),
      scope?.tenantId
        ? Promise.resolve([])
        : prisma.tenant.findMany({
            orderBy: { name: 'asc' },
            select: { id: true, name: true, status: true }
          }),
      prisma.user.findMany({
        where: {
          ...whereScope,
          isActive: true,
          role: { in: ['ADMIN', 'OPS', 'AGENT'] }
        },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true, email: true, role: true }
      })
    ]);

    const locationNameById = new Map(locations.map((row) => [row.id, row.name]));
    const tenantNameById = new Map((tenants || []).map((row) => [row.id, row.name]));
    const employeeNameById = new Map((employees || []).map((row) => [row.id, row.fullName]));

    const selectedTenant = effectiveTenantId
      ? { id: effectiveTenantId, name: tenantNameById.get(effectiveTenantId) || 'Current Tenant' }
      : null;
    const selectedLocation = locationId
      ? { id: locationId, name: locationNameById.get(locationId) || 'Unknown' }
      : null;
    const selectedEmployee = employeeUserId
      ? { id: employeeUserId, name: employeeNameById.get(employeeUserId) || 'Unknown Employee' }
      : null;

    const grouped = new Map();
    const agreementIds = new Set();

    for (const line of lines) {
      const serviceId = line.serviceId || 'unknown';
      const current = grouped.get(serviceId) || {
        serviceId,
        serviceName: line.service?.name || line.description || 'Unknown Service',
        serviceCode: line.service?.code || null,
        unitsSold: 0,
        serviceRevenue: 0,
        commissionAmount: 0,
        agreements: new Set(),
        employees: new Set()
      };
      current.unitsSold += Number(line.quantity || 0);
      current.serviceRevenue += Number(line.lineRevenue || 0);
      current.commissionAmount += Number(line.commissionAmount || 0);
      if (line.agreementCommission?.rentalAgreement?.id) {
        current.agreements.add(line.agreementCommission.rentalAgreement.id);
        agreementIds.add(line.agreementCommission.rentalAgreement.id);
      }
      if (line.agreementCommission?.employeeUserId) current.employees.add(line.agreementCommission.employeeUserId);
      grouped.set(serviceId, current);
    }

    const byService = Array.from(grouped.values())
      .map((row) => ({
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        serviceCode: row.serviceCode,
        unitsSold: Number(row.unitsSold.toFixed ? row.unitsSold.toFixed(2) : row.unitsSold),
        serviceRevenue: Number(row.serviceRevenue.toFixed(2)),
        commissionAmount: Number(row.commissionAmount.toFixed(2)),
        agreementsClosed: row.agreements.size,
        employeesInvolved: row.employees.size
      }))
      .sort((a, b) => b.serviceRevenue - a.serviceRevenue);

    const byEmployeeMap = new Map();
    for (const line of lines) {
      const employee = line.agreementCommission?.employeeUser;
      const employeeId = employee?.id || line.agreementCommission?.employeeUserId || 'unknown';
      const current = byEmployeeMap.get(employeeId) || {
        employeeUserId: employeeId,
        employeeName: employee?.fullName || 'Unknown Employee',
        email: employee?.email || null,
        unitsSold: 0,
        serviceRevenue: 0,
        commissionAmount: 0,
        agreements: new Set()
      };
      current.unitsSold += Number(line.quantity || 0);
      current.serviceRevenue += Number(line.lineRevenue || 0);
      current.commissionAmount += Number(line.commissionAmount || 0);
      if (line.agreementCommission?.rentalAgreement?.id) current.agreements.add(line.agreementCommission.rentalAgreement.id);
      byEmployeeMap.set(employeeId, current);
    }

    const byEmployee = Array.from(byEmployeeMap.values())
      .map((row) => ({
        employeeUserId: row.employeeUserId,
        employeeName: row.employeeName,
        email: row.email,
        unitsSold: Number(row.unitsSold.toFixed ? row.unitsSold.toFixed(2) : row.unitsSold),
        serviceRevenue: Number(row.serviceRevenue.toFixed(2)),
        commissionAmount: Number(row.commissionAmount.toFixed(2)),
        agreementsClosed: row.agreements.size
      }))
      .sort((a, b) => b.commissionAmount - a.commissionAmount);

    return {
      range: {
        start: start.toISOString(),
        end: end.toISOString()
      },
      filters: {
        tenantId: effectiveTenantId,
        tenantName: selectedTenant?.name || null,
        locationId,
        locationName: selectedLocation?.name || null,
        employeeUserId,
        employeeName: selectedEmployee?.name || null
      },
      tenants,
      locations,
      employees,
      summary: {
        servicesSoldCount: byService.length,
        unitsSold: Number(lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0).toFixed(2)),
        serviceRevenue: Number(lines.reduce((sum, line) => sum + Number(line.lineRevenue || 0), 0).toFixed(2)),
        commissionAmount: Number(lines.reduce((sum, line) => sum + Number(line.commissionAmount || 0), 0).toFixed(2)),
        agreementsClosed: agreementIds.size
      },
      byService,
      byEmployee
    };
  }
};
