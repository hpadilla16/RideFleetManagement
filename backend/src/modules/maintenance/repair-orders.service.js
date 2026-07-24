// Maintenance Module — Repair Order service.
// Plan: doc/maintenance-module-plan-2026-06-18.md.
// RepairOrder = central fleet-care record (repairs, damages, incidents, scheduled),
// per-unit numbered, tenant + location scoped. Money rule: costs are an INTERNAL
// record only — NO auto-charge to agreements/claims (that's a separate money path).
// Vehicle.status transitions on open/complete are wired in Fase 4.

import { prisma } from '../../lib/prisma.js';
import { effectiveLocationIds, scopeAllowedLocationIds } from '../../lib/tenant-scope.js';

function badRequest(msg) { const e = new Error(msg); e.status = 400; throw e; }
function notFound(msg) { const e = new Error(msg || 'Not found'); e.status = 404; throw e; }

// On RO open: move the vehicle to IN_MAINTENANCE, but only from a non-locked, non-rented
// state (never yank a car off an active rental; never stomp SOLD/OUT_OF_SERVICE). On the
// last RO closing: drop IN_MAINTENANCE → AVAILABLE and let the hourly sweep reconcile.
async function setVehicleInMaintenance(vehicleId) {
  const v = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { status: true } });
  if (v && ['AVAILABLE', 'RESERVED'].includes(v.status)) {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'IN_MAINTENANCE' } });
  }
}
async function clearVehicleMaintenanceIfDone(vehicleId) {
  const stillOpen = await prisma.repairOrder.count({ where: { vehicleId, status: { in: ['OPEN', 'IN_PROGRESS'] } } });
  if (stillOpen > 0) return;
  const v = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { status: true } });
  if (v?.status === 'IN_MAINTENANCE') {
    await prisma.vehicle.update({ where: { id: vehicleId }, data: { status: 'AVAILABLE' } });
  }
}

// Tenant filter from scope (super-admin with no tenant → no filter).
function tenantWhere(scope) {
  if (scope?.tenantId && scope.tenantId !== '__no_tenant__') return { tenantId: scope.tenantId };
  if (scope?.tenantId === '__no_tenant__') return { tenantId: '__no_tenant__' };
  return {};
}

/**
 * Location filter for a by-id RepairOrder lookup (2026-07-24). RepairOrder has a
 * real `locationId` column, so unlike tolls/citations this needs no relation hop.
 *
 * `list()` uses `effectiveLocationIds(query, scope)` because it also honors a
 * `?locationId` selection; the by-id and mutation paths have no selection to
 * intersect with, so they use the caller's restriction alone.
 *
 * Fail-closed on a null `locationId`: an RO with no location set is invisible to
 * a scoped caller. `create` defaults locationId to the vehicle's homeLocationId,
 * so this is only reachable for rows whose vehicle also had no home location.
 *
 * Returns {} for unrestricted callers, so it composes into any `where`.
 */
function roLocationWhere(scope) {
  const ids = scopeAllowedLocationIds(scope);
  return ids ? { locationId: { in: ids } } : {};
}

const num = (v) => (v == null ? 0 : Number(v) || 0);

// Derive RO totals from its lines (subtotal, tax, total).
function totalsFor(lines) {
  let subtotal = 0; let tax = 0;
  for (const l of (lines || [])) {
    const amt = num(l.amount);
    if (String(l.type) === 'TAX') tax += amt; else subtotal += amt;
  }
  return { subtotal: round2(subtotal), tax: round2(tax), total: round2(subtotal + tax) };
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

function shape(ro) {
  if (!ro) return null;
  const lines = (ro.lines || []).map((l) => ({
    id: l.id, type: l.type, description: l.description,
    qty: num(l.qty), unitCost: num(l.unitCost), amount: num(l.amount),
  }));
  return {
    id: ro.id,
    roNumber: ro.roNumber,
    label: ro.vehicle ? `RO-${String(ro.roNumber).padStart(4, '0')}` : `RO-${ro.roNumber}`,
    status: ro.status,
    source: ro.source,
    vehicleId: ro.vehicleId,
    vehicle: ro.vehicle ? { id: ro.vehicle.id, plate: ro.vehicle.plate, make: ro.vehicle.make, model: ro.vehicle.model, year: ro.vehicle.year, internalNumber: ro.vehicle.internalNumber } : null,
    locationId: ro.locationId,
    location: ro.location ? { id: ro.location.id, code: ro.location.code, name: ro.location.name } : null,
    odometerAtOpen: ro.odometerAtOpen,
    openedAt: ro.openedAt,
    completedAt: ro.completedAt,
    enteredByUserId: ro.enteredByUserId,
    vendor: ro.vendor,
    poNumber: ro.poNumber,
    notes: ro.notes,
    incidentId: ro.incidentId,
    lines,
    totals: totalsFor(ro.lines),
    damageCount: Array.isArray(ro.damageReports) ? ro.damageReports.length : undefined,
    damageReports: Array.isArray(ro.damageReports)
      ? ro.damageReports.map((d) => ({ id: d.id, status: d.status, view: d.view, description: d.description }))
      : undefined,
    createdAt: ro.createdAt,
    updatedAt: ro.updatedAt,
  };
}

const VEHICLE_SELECT = { id: true, plate: true, make: true, model: true, year: true, internalNumber: true, mileage: true, homeLocationId: true };
const LINE_SELECT = true;
const DETAIL_INCLUDE = {
  vehicle: { select: VEHICLE_SELECT },
  location: { select: { id: true, code: true, name: true } },
  lines: { orderBy: { createdAt: 'asc' } },
  damageReports: { select: { id: true, status: true, view: true, description: true, photoJson: true, fixedPhotoJson: true } },
};

export const repairOrdersService = {
  async list(query = {}, scope = {}) {
    const where = { ...tenantWhere(scope) };
    if (query.status) where.status = String(query.status).toUpperCase();
    if (query.source) where.source = String(query.source).toUpperCase();
    if (query.vehicleId) where.vehicleId = String(query.vehicleId);
    // Location scoping (2026-07-23). RepairOrder has a real `locationId`, so the
    // caller's allowed locations ∩ ?locationId goes straight into the where.
    // Without this the /maintenance board contradicted its own KPI tile: the
    // tile (summary(), already scoped) said 3 open ROs while the board under it
    // listed the whole tenant's 40. `get`, `vehicleHistory` and the mutations
    // were closed the same way on 2026-07-24 (see roLocationWhere).
    const effLocIds = effectiveLocationIds(query, scope);
    if (effLocIds) where.locationId = { in: effLocIds };
    const rows = await prisma.repairOrder.findMany({
      where,
      include: { vehicle: { select: VEHICLE_SELECT }, location: { select: { id: true, code: true, name: true } }, lines: true, damageReports: { select: { id: true } } },
      orderBy: [{ openedAt: 'desc' }],
      take: Math.min(Number(query.limit) || 300, 1000),
    });
    return { repairOrders: rows.map(shape) };
  },

  async get(id, scope = {}) {
    const ro = await prisma.repairOrder.findFirst({ where: { id: String(id), ...tenantWhere(scope), ...roLocationWhere(scope) }, include: DETAIL_INCLUDE });
    if (!ro) notFound('Repair order not found');
    return shape(ro);
  },

  async vehicleHistory(vehicleId, scope = {}) {
    const rows = await prisma.repairOrder.findMany({
      where: { vehicleId: String(vehicleId), ...tenantWhere(scope), ...roLocationWhere(scope) },
      include: { lines: true, location: { select: { id: true, code: true, name: true } }, damageReports: { select: { id: true } } },
      orderBy: { openedAt: 'desc' },
    });
    return { repairOrders: rows.map(shape) };
  },

  // Create an RO. roNumber is a per-vehicle sequence (retry once on the unique race).
  async create(body = {}, scope = {}) {
    const tenantId = scope?.tenantId;
    if (!tenantId || tenantId === '__no_tenant__') badRequest('tenantId required');
    const vehicleId = String(body.vehicleId || '');
    if (!vehicleId) badRequest('vehicleId required');
    // Location scoping (2026-07-24). A scoped caller may only open an RO on a
    // vehicle homed at one of their locations — otherwise they could create
    // (and, through the roll-up below, mutate damages on) another branch's car.
    const allowedLoc = scopeAllowedLocationIds(scope);
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: vehicleId, tenantId, ...(allowedLoc ? { homeLocationId: { in: allowedLoc } } : {}) },
      select: { id: true, mileage: true, homeLocationId: true },
    });
    if (!vehicle) notFound('Vehicle not found');
    // Reject an out-of-scope explicit locationId up front. Without this the row
    // would be created and then vanish behind the scoped `get()` below — a 404
    // on a successful write, with an orphan RO left at the other branch.
    if (allowedLoc && body.locationId && !allowedLoc.includes(String(body.locationId))) {
      badRequest('locationId is outside your assigned locations');
    }

    const source = ['SCHEDULED', 'DAMAGE', 'INCIDENT', 'MANUAL'].includes(String(body.source).toUpperCase())
      ? String(body.source).toUpperCase() : 'MANUAL';
    const data = {
      tenantId,
      vehicleId,
      locationId: body.locationId || vehicle.homeLocationId || null,
      source,
      status: 'OPEN',
      odometerAtOpen: body.odometerAtOpen != null ? Number(body.odometerAtOpen) : (vehicle.mileage ?? null),
      enteredByUserId: scope.userId || null,
      vendor: body.vendor || null,
      poNumber: body.poNumber || null,
      notes: body.notes || null,
      incidentId: body.incidentId || null,
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const last = await prisma.repairOrder.findFirst({ where: { vehicleId }, orderBy: { roNumber: 'desc' }, select: { roNumber: true } });
      const roNumber = (last?.roNumber || 0) + 1 + attempt;
      try {
        const created = await prisma.repairOrder.create({ data: { ...data, roNumber }, include: DETAIL_INCLUDE });
        // Opening an RO takes the car into maintenance (Fase 4 wire-up).
        await setVehicleInMaintenance(vehicleId);
        // Optionally attach damages passed at create (roll-up).
        if (Array.isArray(body.damageReportIds) && body.damageReportIds.length) {
          await prisma.vehicleDamageReport.updateMany({
            where: { id: { in: body.damageReportIds.map(String) }, vehicleId, tenantId },
            data: { repairOrderId: created.id },
          });
          return this.get(created.id, scope);
        }
        return this.get(created.id, scope);
      } catch (e) {
        if (String(e?.code) === 'P2002' && attempt < 2) continue; // roNumber race → retry
        throw e;
      }
    }
    badRequest('Could not assign a repair order number, try again');
  },

  async update(id, body = {}, scope = {}) {
    const ro = await prisma.repairOrder.findFirst({ where: { id: String(id), ...tenantWhere(scope), ...roLocationWhere(scope) }, select: { id: true, status: true } });
    if (!ro) notFound('Repair order not found');
    const data = {};
    for (const k of ['vendor', 'poNumber', 'notes']) if (body[k] !== undefined) data[k] = body[k] || null;
    if (body.locationId !== undefined) {
      // A scoped caller must not push an RO out of their own scope (including to
      // null), which would silently hand it to another branch and 404 the
      // `get()` on the way out.
      const allowedLoc = scopeAllowedLocationIds(scope);
      if (allowedLoc && !(body.locationId && allowedLoc.includes(String(body.locationId)))) {
        badRequest('locationId is outside your assigned locations');
      }
      data.locationId = body.locationId || null;
    }
    if (body.odometerAtOpen !== undefined) data.odometerAtOpen = body.odometerAtOpen == null ? null : Number(body.odometerAtOpen);
    if (body.status && ['OPEN', 'IN_PROGRESS'].includes(String(body.status).toUpperCase())) data.status = String(body.status).toUpperCase();
    await prisma.repairOrder.update({ where: { id: ro.id }, data });
    return this.get(ro.id, scope);
  },

  // ── Lines ──
  async addLine(id, body = {}, scope = {}) {
    const ro = await prisma.repairOrder.findFirst({ where: { id: String(id), ...tenantWhere(scope), ...roLocationWhere(scope) }, select: { id: true } });
    if (!ro) notFound('Repair order not found');
    const type = ['PART', 'LABOR', 'OTHER', 'TAX'].includes(String(body.type).toUpperCase()) ? String(body.type).toUpperCase() : 'PART';
    const qty = body.qty != null ? Number(body.qty) : 1;
    const unitCost = Number(body.unitCost) || 0;
    const amount = body.amount != null ? Number(body.amount) : round2(qty * unitCost);
    if (!String(body.description || '').trim()) badRequest('Line description required');
    await prisma.repairOrderLine.create({ data: { repairOrderId: ro.id, type, description: String(body.description).trim(), qty, unitCost, amount } });
    return this.get(ro.id, scope);
  },

  async deleteLine(id, lineId, scope = {}) {
    const ro = await prisma.repairOrder.findFirst({ where: { id: String(id), ...tenantWhere(scope), ...roLocationWhere(scope) }, select: { id: true } });
    if (!ro) notFound('Repair order not found');
    await prisma.repairOrderLine.deleteMany({ where: { id: String(lineId), repairOrderId: ro.id } });
    return this.get(ro.id, scope);
  },

  // Complete an RO → mark its grouped damages FIXED (reusing their repair photo if present).
  // Vehicle.status transition is wired in Fase 4.
  async complete(id, scope = {}) {
    const ro = await prisma.repairOrder.findFirst({ where: { id: String(id), ...tenantWhere(scope), ...roLocationWhere(scope) }, include: { damageReports: { select: { id: true, fixedPhotoJson: true, status: true } } } });
    if (!ro) notFound('Repair order not found');
    if (ro.status === 'COMPLETED') return this.get(ro.id, scope);
    if (ro.status === 'CANCELLED') badRequest('Cannot complete a cancelled repair order');
    await prisma.$transaction([
      prisma.repairOrder.update({ where: { id: ro.id }, data: { status: 'COMPLETED', completedAt: new Date() } }),
      ...(ro.damageReports.length
        ? [prisma.vehicleDamageReport.updateMany({
            where: { id: { in: ro.damageReports.map((d) => d.id) }, status: { not: 'FIXED' } },
            data: { status: 'FIXED', fixedAt: new Date(), fixedByUserId: scope.userId || null },
          })]
        : []),
    ]);
    await clearVehicleMaintenanceIfDone(ro.vehicleId);
    return this.get(ro.id, scope);
  },

  async cancel(id, scope = {}) {
    const ro = await prisma.repairOrder.findFirst({ where: { id: String(id), ...tenantWhere(scope), ...roLocationWhere(scope) }, select: { id: true, status: true, vehicleId: true } });
    if (!ro) notFound('Repair order not found');
    if (ro.status !== 'COMPLETED') {
      await prisma.repairOrder.update({ where: { id: ro.id }, data: { status: 'CANCELLED' } });
      // Un-link any grouped damages so they can be rolled into a new RO.
      await prisma.vehicleDamageReport.updateMany({ where: { repairOrderId: ro.id }, data: { repairOrderId: null } });
      await clearVehicleMaintenanceIfDone(ro.vehicleId);
    }
    return this.get(ro.id, scope);
  },

  // Roll one or more VehicleDamageReports into a new RO (source=DAMAGE).
  async fromDamage(body = {}, scope = {}) {
    const ids = Array.isArray(body.damageReportIds) ? body.damageReportIds.map(String) : [];
    if (!ids.length) badRequest('damageReportIds required');
    const tenantId = scope?.tenantId;
    // Location scoping (2026-07-24) hops through the damaged vehicle — a
    // VehicleDamageReport has no location of its own. `create` below re-checks
    // the vehicle anyway, so this mainly keeps the 404 honest instead of
    // failing later with a confusing "Vehicle not found".
    const allowedLoc = scopeAllowedLocationIds(scope);
    const damages = await prisma.vehicleDamageReport.findMany({
      where: {
        id: { in: ids },
        ...(tenantId && tenantId !== '__no_tenant__' ? { tenantId } : {}),
        ...(allowedLoc ? { vehicle: { is: { homeLocationId: { in: allowedLoc } } } } : {}),
      },
      select: { id: true, vehicleId: true },
    });
    if (!damages.length) notFound('Damage reports not found');
    const vehicleId = damages[0].vehicleId;
    if (damages.some((d) => d.vehicleId !== vehicleId)) badRequest('All damages must be on the same vehicle');
    return this.create({ vehicleId, source: 'DAMAGE', damageReportIds: damages.map((d) => d.id), notes: body.notes }, scope);
  },
};
