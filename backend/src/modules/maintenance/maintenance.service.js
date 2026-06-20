// Maintenance Module — the HUB: KPIs by location, work-item board, and the
// service-interval "due" list (computed live from the vehicle's odometer + last
// service). Plan: doc/maintenance-module-plan-2026-06-18.md.

import { prisma } from '../../lib/prisma.js';
import { repairOrdersService } from './repair-orders.service.js';

const MILE_SOON = 500;   // within 500 mi of the interval → "due soon"
const DAY_SOON = 14;     // within 14 days → "due soon"
const num = (v) => (v == null ? 0 : Number(v) || 0);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function tenantWhere(scope) {
  if (scope?.tenantId && scope.tenantId !== '__no_tenant__') return { tenantId: scope.tenantId };
  if (scope?.tenantId === '__no_tenant__') return { tenantId: '__no_tenant__' };
  return {};
}

const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS'];

// Compute due/soon for one service schedule against the vehicle's live mileage + today.
function evalSchedule(s, vehicleMileage, now) {
  let dueByMiles = null; let nextDueMiles = null;
  if (s.intervalMiles && s.lastServiceMiles != null) {
    nextDueMiles = s.lastServiceMiles + s.intervalMiles;
    if (vehicleMileage != null) dueByMiles = vehicleMileage - nextDueMiles; // ≥0 overdue, [-SOON,0) soon
  }
  let dueByDays = null; let nextDueAt = null;
  if (s.intervalDays && s.lastServiceAt) {
    nextDueAt = new Date(new Date(s.lastServiceAt).getTime() + s.intervalDays * 86400000);
    dueByDays = Math.round((now - nextDueAt) / 86400000); // ≥0 overdue, [-SOON,0) soon
  }
  const overdue = (dueByMiles != null && dueByMiles >= 0) || (dueByDays != null && dueByDays >= 0);
  const soon = !overdue && ((dueByMiles != null && dueByMiles >= -MILE_SOON) || (dueByDays != null && dueByDays >= -DAY_SOON));
  return { nextDueMiles, nextDueAt, dueByMiles, dueByDays, overdue, soon };
}

export const maintenanceService = {
  // Service intervals that are overdue or due soon, with the live odometer gap.
  async due(query = {}, scope = {}) {
    const where = { ...tenantWhere(scope), active: true };
    const schedules = await prisma.serviceSchedule.findMany({
      where,
      include: { vehicle: { select: { id: true, plate: true, make: true, model: true, year: true, internalNumber: true, mileage: true, homeLocationId: true } } },
    });
    const now = Date.now();
    const locationId = query.locationId ? String(query.locationId) : null;
    const items = [];
    for (const s of schedules) {
      if (locationId && s.vehicle?.homeLocationId !== locationId) continue;
      const ev = evalSchedule(s, s.vehicle?.mileage ?? null, now);
      if (!ev.overdue && !ev.soon) continue;
      items.push({
        id: s.id,
        serviceType: s.serviceType,
        vehicleId: s.vehicleId,
        vehicle: s.vehicle ? { id: s.vehicle.id, plate: s.vehicle.plate, make: s.vehicle.make, model: s.vehicle.model, year: s.vehicle.year, internalNumber: s.vehicle.internalNumber, mileage: s.vehicle.mileage } : null,
        intervalMiles: s.intervalMiles, intervalDays: s.intervalDays,
        lastServiceMiles: s.lastServiceMiles, lastServiceAt: s.lastServiceAt,
        ...ev,
        state: ev.overdue ? 'OVERDUE' : 'SOON',
      });
    }
    // Overdue first, then by how far past.
    items.sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || (num(b.dueByMiles) - num(a.dueByMiles)));
    return { items, count: items.length };
  },

  async summary(query = {}, scope = {}) {
    const where = { ...tenantWhere(scope) };
    const locationId = query.locationId ? String(query.locationId) : null;
    const roWhere = { ...where, ...(locationId ? { locationId } : {}) };

    const [openCount, inProgressCount, due, monthStart] = await Promise.all([
      prisma.repairOrder.count({ where: { ...roWhere, status: 'OPEN' } }),
      prisma.repairOrder.count({ where: { ...roWhere, status: 'IN_PROGRESS' } }),
      this.due(query, scope),
      Promise.resolve(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
    ]);

    // Cost MTD = sum of all line amounts on ROs completed this month.
    const completed = await prisma.repairOrder.findMany({
      where: { ...roWhere, status: 'COMPLETED', completedAt: { gte: monthStart } },
      select: { lines: { select: { amount: true } } },
    });
    const costMTD = round2(completed.reduce((acc, ro) => acc + ro.lines.reduce((a, l) => a + num(l.amount), 0), 0));

    // Fleet down = vehicles with an open/in-progress RO (or status IN_MAINTENANCE/OUT_OF_SERVICE).
    const downVehicleRows = await prisma.repairOrder.findMany({
      where: { ...roWhere, status: { in: OPEN_STATUSES } }, select: { vehicleId: true }, distinct: ['vehicleId'],
    });
    const fleetWhere = { ...where, status: { notIn: ['SOLD'] }, ...(locationId ? { homeLocationId: locationId } : {}) };
    const fleetTotal = await prisma.vehicle.count({ where: fleetWhere });
    const down = downVehicleRows.length;

    return {
      openRepairOrders: openCount + inProgressCount,
      open: openCount,
      inProgress: inProgressCount,
      dueSoon: due.count,
      overdue: due.items.filter((i) => i.overdue).length,
      vehiclesDown: down,
      fleetTotal,
      fleetDownPct: fleetTotal > 0 ? Math.round((down / fleetTotal) * 100) : 0,
      costMTD,
    };
  },

  // Board = the RO work items (reuses the RO list), filterable by location/status.
  async board(query = {}, scope = {}) {
    return repairOrdersService.list(query, scope);
  },

  // ── Service schedules (per-unit intervals) ──
  async listSchedules(vehicleId, scope = {}) {
    const rows = await prisma.serviceSchedule.findMany({
      where: { vehicleId: String(vehicleId), ...tenantWhere(scope) },
      orderBy: { serviceType: 'asc' },
    });
    const veh = await prisma.vehicle.findFirst({ where: { id: String(vehicleId), ...tenantWhere(scope) }, select: { mileage: true } });
    const now = Date.now();
    return {
      schedules: rows.map((s) => ({
        id: s.id, serviceType: s.serviceType, intervalMiles: s.intervalMiles, intervalDays: s.intervalDays,
        lastServiceMiles: s.lastServiceMiles, lastServiceAt: s.lastServiceAt, active: s.active,
        ...evalSchedule(s, veh?.mileage ?? null, now),
      })),
    };
  },

  async upsertSchedule(vehicleId, body = {}, scope = {}) {
    const tenantId = scope?.tenantId;
    if (!tenantId || tenantId === '__no_tenant__') { const e = new Error('tenantId required'); e.status = 400; throw e; }
    const veh = await prisma.vehicle.findFirst({ where: { id: String(vehicleId), tenantId }, select: { id: true } });
    if (!veh) { const e = new Error('Vehicle not found'); e.status = 404; throw e; }
    const serviceType = String(body.serviceType || '').toUpperCase();
    if (!['LOF', 'TIRE_ROTATION', 'BRAKES', 'INSPECTION', 'OTHER'].includes(serviceType)) { const e = new Error('Invalid serviceType'); e.status = 400; throw e; }
    const data = {
      intervalMiles: body.intervalMiles != null && body.intervalMiles !== '' ? Math.round(Number(body.intervalMiles)) : null,
      intervalDays: body.intervalDays != null && body.intervalDays !== '' ? Math.round(Number(body.intervalDays)) : null,
      lastServiceMiles: body.lastServiceMiles != null && body.lastServiceMiles !== '' ? Math.round(Number(body.lastServiceMiles)) : null,
      lastServiceAt: body.lastServiceAt ? new Date(body.lastServiceAt) : null,
      active: body.active === undefined ? true : !!body.active,
    };
    const row = await prisma.serviceSchedule.upsert({
      where: { vehicleId_serviceType: { vehicleId: String(vehicleId), serviceType } },
      create: { tenantId, vehicleId: String(vehicleId), serviceType, ...data },
      update: data,
    });
    return { id: row.id };
  },

  async deleteSchedule(vehicleId, serviceType, scope = {}) {
    await prisma.serviceSchedule.deleteMany({ where: { vehicleId: String(vehicleId), serviceType: String(serviceType).toUpperCase(), ...tenantWhere(scope) } });
    return { ok: true };
  },
};
