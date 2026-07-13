// Maintenance Module — the HUB: KPIs by location, work-item board, and the
// service-interval "due" list (computed live from the vehicle's odometer + last
// service). Plan: doc/maintenance-module-plan-2026-06-18.md.

import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { repairOrdersService } from './repair-orders.service.js';

const MILE_SOON = 500;   // within 500 mi of the interval → "due soon"
const DAY_SOON = 14;     // within 14 days → "due soon"
const SERVICE_TYPES = ['LOF', 'TIRE_ROTATION', 'BRAKES', 'INSPECTION', 'OTHER'];
const num = (v) => (v == null ? 0 : Number(v) || 0);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function tenantWhere(scope) {
  if (scope?.tenantId && scope.tenantId !== '__no_tenant__') return { tenantId: scope.tenantId };
  if (scope?.tenantId === '__no_tenant__') return { tenantId: '__no_tenant__' };
  return {};
}

const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS'];

// Compute due/soon for one service schedule against the vehicle's live mileage + today.
// Exported for unit tests.
//
// Status is MILEAGE-DRIVEN (Hector, 2026-07-13): when the schedule tracks miles,
// only the odometer decides ok/soon/overdue — the day-based next-due is still
// computed and returned as informational, but a calendar lapse never flags a
// low-use car whose odometer says it's fine. Days decide the status only when
// the schedule has no mileage basis at all (no intervalMiles, or no odometer/
// mileage baseline to measure against). A schedule with neither basis is
// INACTIVE: no due until someone records the last service.
export function evalSchedule(s, vehicleMileage, now) {
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
  const basis = dueByMiles != null ? 'MILES' : (dueByDays != null ? 'DAYS' : null);
  let overdue = false; let soon = false;
  if (basis === 'MILES') {
    overdue = dueByMiles >= 0;
    soon = !overdue && dueByMiles >= -MILE_SOON;
  } else if (basis === 'DAYS') {
    overdue = dueByDays >= 0;
    soon = !overdue && dueByDays >= -DAY_SOON;
  }
  return { basis, nextDueMiles, nextDueAt, dueByMiles, dueByDays, overdue, soon };
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
    // Location scoping (Fase 2c): limit to the user's allowed locations (∩ selection).
    const _allowedLoc = Array.isArray(scope?.allowedLocationIds) && scope.allowedLocationIds.length
      ? scope.allowedLocationIds : null;
    const _effLocIds = _allowedLoc
      ? (locationId && _allowedLoc.includes(locationId) ? [locationId] : _allowedLoc)
      : (locationId ? [locationId] : null);
    const roWhere = { ...where, ...(_effLocIds ? { locationId: { in: _effLocIds } } : {}) };
    const fleetLoc = _effLocIds ? { homeLocationId: { in: _effLocIds } } : {};

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
    const fleetWhere = { ...where, status: { notIn: ['SOLD'] }, ...fleetLoc };
    const fleetTotal = await prisma.vehicle.count({ where: fleetWhere });
    const down = downVehicleRows.length;

    return {
      openRepairOrders: openCount + inProgressCount,
      open: openCount,
      inProgress: inProgressCount,
      // dueSoon = TOTAL actionable (overdue + soon) — /maintenance displays it
      // as-is; dueSoonOnly = the "soon, not yet overdue" slice for consumers
      // that break the two out (dashboard tile). Don't repurpose dueSoon.
      dueSoon: due.count,
      dueSoonOnly: due.count - due.items.filter((i) => i.overdue).length,
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
    const [rows, veh] = await Promise.all([
      prisma.serviceSchedule.findMany({
        where: { vehicleId: String(vehicleId), ...tenantWhere(scope) },
        orderBy: { serviceType: 'asc' },
      }),
      prisma.vehicle.findFirst({ where: { id: String(vehicleId), ...tenantWhere(scope) }, select: { mileage: true } }),
    ]);
    const now = Date.now();
    return {
      vehicleMileage: veh?.mileage ?? null,
      schedules: rows.map((s) => ({
        id: s.id, serviceType: s.serviceType, intervalMiles: s.intervalMiles, intervalDays: s.intervalDays,
        lastServiceMiles: s.lastServiceMiles, lastServiceAt: s.lastServiceAt, active: s.active,
        ...evalSchedule(s, veh?.mileage ?? null, now),
      })),
    };
  },

  async upsertSchedule(vehicleId, body = {}, scope = {}) {
    // Super admins reach this without a tenant in scope (the profile UI doesn't
    // pass ?tenantId) — the vehicle row itself is the tenant source of truth.
    if (scope?.tenantId === '__no_tenant__') { const e = new Error('tenantId required'); e.status = 400; throw e; }
    const veh = await prisma.vehicle.findFirst({
      where: { id: String(vehicleId), ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true, tenantId: true },
    });
    if (!veh) { const e = new Error('Vehicle not found'); e.status = 404; throw e; }
    const tenantId = scope?.tenantId || veh.tenantId;
    const serviceType = String(body.serviceType || '').toUpperCase();
    if (!SERVICE_TYPES.includes(serviceType)) { const e = new Error('Invalid serviceType'); e.status = 400; throw e; }
    // Clean 400 for junk numbers — NaN would surface as a Prisma 500, and a
    // negative interval is an instantly-overdue schedule (QA hardening).
    const toInt = (v, label, min) => {
      if (v == null || v === '') return null;
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < min) { const e = new Error(`Invalid ${label}`); e.status = 400; throw e; }
      return n;
    };
    const data = {
      intervalMiles: toInt(body.intervalMiles, 'intervalMiles', 1),
      intervalDays: toInt(body.intervalDays, 'intervalDays', 1),
      // (validated below — a schedule with no interval at all can never be due)
      lastServiceMiles: toInt(body.lastServiceMiles, 'lastServiceMiles', 0),
      lastServiceAt: body.lastServiceAt ? new Date(body.lastServiceAt) : null,
      active: body.active === undefined ? true : !!body.active,
    };
    if (data.intervalMiles == null && data.intervalDays == null) { const e = new Error('At least one interval (miles or days) is required'); e.status = 400; throw e; }
    const row = await prisma.serviceSchedule.upsert({
      where: { vehicleId_serviceType: { vehicleId: String(vehicleId), serviceType } },
      create: { tenantId, vehicleId: String(vehicleId), serviceType, ...data },
      update: data,
    });
    return { id: row.id };
  },

  // "Log service" (Hector, 2026-07-13): a service was just DONE — roll the
  // baseline to the vehicle's CURRENT odometer (read server-side, never from
  // the client) + now, so the next due recomputes from the real event. The
  // schedule row must already exist (create it from the vehicle profile first).
  // AuditLog can't hold this (reservationId is required there), so the audit
  // trail is a structured log line with actor + before/after.
  // TODO(hook): accept an optional repairOrderId to tie the RO that did the work.
  // opts.db is injectable for tests; opts.now for determinism.
  async logService(vehicleId, serviceType, scope = {}, opts = {}) {
    const db = opts.db || prisma;
    // Same super-admin rule as upsertSchedule: no tenant in scope → the vehicle
    // row is the tenant source of truth.
    if (scope?.tenantId === '__no_tenant__') { const e = new Error('tenantId required'); e.status = 400; throw e; }
    const type = String(serviceType || '').toUpperCase();
    if (!SERVICE_TYPES.includes(type)) { const e = new Error('Invalid serviceType'); e.status = 400; throw e; }
    const veh = await db.vehicle.findFirst({
      where: { id: String(vehicleId), ...(scope?.tenantId ? { tenantId: scope.tenantId } : {}) },
      select: { id: true, mileage: true, tenantId: true },
    });
    if (!veh) { const e = new Error('Vehicle not found'); e.status = 404; throw e; }
    const tenantId = scope?.tenantId || veh.tenantId;
    const existing = await db.serviceSchedule.findFirst({ where: { vehicleId: String(vehicleId), serviceType: type, tenantId } });
    if (!existing) { const e = new Error('Schedule not found'); e.status = 404; throw e; }
    // Never fabricate a baseline: without a real odometer reading, rolling to 0
    // would silently activate the miles basis with invented data (and read as
    // thousands of miles overdue the moment a real reading lands).
    if (veh.mileage == null) { const e = new Error('Vehicle has no odometer reading — record its mileage first'); e.status = 400; throw e; }
    const now = opts.now ? new Date(opts.now) : new Date();
    const lastServiceMiles = veh.mileage;
    const row = await db.serviceSchedule.update({
      where: { id: existing.id },
      data: { lastServiceMiles, lastServiceAt: now },
    });
    logger.info('[maintenance] log-service: baseline rolled to current odometer', {
      tenantId, vehicleId: String(vehicleId), serviceType: type,
      actorUserId: opts.actorUserId || null,
      before: { lastServiceMiles: existing.lastServiceMiles, lastServiceAt: existing.lastServiceAt },
      after: { lastServiceMiles, lastServiceAt: now },
    });
    return {
      id: row.id, serviceType: type, intervalMiles: row.intervalMiles, intervalDays: row.intervalDays,
      lastServiceMiles: row.lastServiceMiles, lastServiceAt: row.lastServiceAt, active: row.active,
      ...evalSchedule(row, veh.mileage ?? null, now.getTime()),
    };
  },

  async deleteSchedule(vehicleId, serviceType, scope = {}) {
    const type = String(serviceType || '').toUpperCase();
    if (!SERVICE_TYPES.includes(type)) { const e = new Error('Invalid serviceType'); e.status = 400; throw e; }
    await prisma.serviceSchedule.deleteMany({ where: { vehicleId: String(vehicleId), serviceType: type, ...tenantWhere(scope) } });
    return { ok: true };
  },
};
