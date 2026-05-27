/**
 * Availability — Round 29 (2026-05-23).
 *
 * Right-now snapshot of every vehicle's state, grouped by vehicle type. Pure
 * current-state view — no date range. Source: Vehicle.status across the
 * five-value enum (AVAILABLE / RESERVED / ON_RENT / IN_MAINTENANCE /
 * OUT_OF_SERVICE).
 *
 *   GET /api/reports/availability?locationId=
 *     Returns { asOf, totals, types[], statusOrder, filters }
 *
 *   GET /api/reports/availability/type?type=<typeId>&locationId=<?>
 *     Drill-down for one vehicle type. Returns the individual vehicles in
 *     that class, including the active reservation for any ON_RENT cars
 *     (customer name + return time).
 *
 * "Available now" = AVAILABLE only. RESERVED is assigned-but-not-out, ON_RENT
 * is with-customer. The "Out of service" KPI rolls IN_MAINTENANCE +
 * OUT_OF_SERVICE together since both prevent rental.
 */

import { registerReport } from './reports-v2.routes.js';
import {
  DEFAULT_TENANT_TIMEZONE,
  startOfDayInTz,
  dayLabelInTz,
} from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

const VEHICLE_STATUSES = ['AVAILABLE', 'RESERVED', 'ON_RENT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE'];
const ACTIVE_RESERVATION_STATUSES = ['CHECKED_OUT', 'CHECKED_IN_UNPAID'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// 2026-05-26: tz-aware helpers — display dates were in server-local TZ.
function startOfDay(d, tz = DEFAULT_TENANT_TIMEZONE) { return startOfDayInTz(d, tz); }
function isoDay(d) { return d.toISOString().slice(0, 10); }
function dayLabel(d, tz = DEFAULT_TENANT_TIMEZONE) { return dayLabelInTz(d, tz); }
function timeLabel(d, tz = DEFAULT_TENANT_TIMEZONE) {
  const out = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return out.replace(' AM', 'am').replace(' PM', 'pm').replace(' ', '');
}

function makeEmptyCounts() {
  return { AVAILABLE: 0, RESERVED: 0, ON_RENT: 0, IN_MAINTENANCE: 0, OUT_OF_SERVICE: 0 };
}

// ---------------------------------------------------------------------------
// Prisma
// ---------------------------------------------------------------------------

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

// ---------------------------------------------------------------------------
// Pure aggregation — exposed for unit testing
// ---------------------------------------------------------------------------

/**
 * Group vehicles by their type, counting each VehicleStatus enum value. The
 * input shape mirrors the Prisma select used by computeData:
 *   { status, vehicleType: { id, code, name } }
 */
function aggregateByType(vehicles) {
  const byType = new Map();
  for (const v of vehicles) {
    const vt = v.vehicleType;
    if (!vt?.id) continue;
    if (!byType.has(vt.id)) {
      byType.set(vt.id, {
        id: vt.id,
        code: vt.code || null,
        name: vt.name || vt.code || '(unnamed)',
        capacity: 0,
        counts: makeEmptyCounts(),
      });
    }
    const t = byType.get(vt.id);
    t.capacity += 1;
    if (VEHICLE_STATUSES.includes(v.status)) {
      t.counts[v.status] += 1;
    } else {
      // Unknown status — fold into OUT_OF_SERVICE conservatively
      t.counts.OUT_OF_SERVICE += 1;
    }
  }
  // Sort by capacity desc so the biggest classes lead the table
  return Array.from(byType.values()).sort((a, b) => b.capacity - a.capacity);
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const locationId = (query && query.locationId) || null;
  const asOf = (deps && deps.now) || new Date();

  const where = { tenantId };
  if (locationId) where.homeLocationId = locationId;

  const vehicles = await prisma.vehicle.findMany({
    where,
    select: {
      id: true,
      status: true,
      vehicleType: { select: { id: true, code: true, name: true } },
    },
  });

  // 2026-05-27: Vehicle.status drifts from reality (a vehicle gets a
  // CHECKED_OUT reservation but its status row isn't flipped to ON_RENT).
  // Same fix as fleet-status: override effective status to ON_RENT when
  // an active CHECKED_OUT reservation exists for the vehicle right now.
  // returnAt > now filters out stuck CHECKED_OUT rows past their planned
  // return — usually stale data (returned without system update). Matches
  // the Reports Snapshot + Fleet Status definitions.
  const activeReservations = await prisma.reservation.findMany({
    where: {
      tenantId,
      status: 'CHECKED_OUT',
      pickupAt: { lte: asOf },
      returnAt: { gt: asOf },
      vehicleId: { not: null },
      ...(locationId ? { vehicle: { homeLocationId: locationId } } : {}),
    },
    select: { vehicleId: true },
  });
  const onRentVehicleIds = new Set(activeReservations.map((r) => r.vehicleId).filter(Boolean));

  const vehiclesWithEffectiveStatus = vehicles.map((v) => {
    let effective = v.status;
    if (onRentVehicleIds.has(v.id) && (effective === 'AVAILABLE' || effective === 'RESERVED')) {
      effective = 'ON_RENT';
    }
    return { ...v, status: effective };
  });

  const types = aggregateByType(vehiclesWithEffectiveStatus);

  // Fleet totals
  const totals = { capacity: 0, ...makeEmptyCounts() };
  for (const t of types) {
    totals.capacity += t.capacity;
    for (const s of VEHICLE_STATUSES) totals[s] += t.counts[s];
  }
  const outOfServiceTotal = totals.IN_MAINTENANCE + totals.OUT_OF_SERVICE;
  const availablePct = totals.capacity > 0 ? totals.AVAILABLE / totals.capacity : 0;
  const onRentPct = totals.capacity > 0 ? totals.ON_RENT / totals.capacity : 0;
  const outOfServicePct = totals.capacity > 0 ? outOfServiceTotal / totals.capacity : 0;

  return {
    asOf: asOf.toISOString(),
    asOfLabel: `${dayLabel(asOf, tenantTz)} · ${timeLabel(asOf, tenantTz)}`,
    tenantTimeZone: tenantTz,
    totals: {
      ...totals,
      outOfServiceTotal,
      availablePct,
      onRentPct,
      outOfServicePct,
    },
    types,
    statusOrder: VEHICLE_STATUSES,
    filters: { locationId },
  };
}

// ---------------------------------------------------------------------------
// Drill-down — vehicles within one type
// ---------------------------------------------------------------------------

async function typeDrillDownHandler(req, res, { tenantId }) {
  const prisma = await resolveDefaultPrisma();
  const tenantTz = await resolveTenantTimeZone(tenantId);
  const typeId = (req.query?.type || req.query?.typeId || '').toString();
  const locationId = req.query?.locationId ? String(req.query.locationId) : null;
  if (!typeId) {
    return res.status(400).json({ error: 'type query param required' });
  }

  const where = { tenantId, vehicleTypeId: typeId };
  if (locationId) where.homeLocationId = locationId;

  const vehicles = await prisma.vehicle.findMany({
    where,
    select: {
      id: true,
      plate: true,
      internalNumber: true,
      year: true,
      make: true,
      model: true,
      color: true,
      mileage: true,
      status: true,
      vehicleType: { select: { id: true, code: true, name: true } },
      homeLocation: { select: { id: true, name: true } },
      reservations: {
        where: { status: { in: ACTIVE_RESERVATION_STATUSES } },
        orderBy: { pickupAt: 'desc' },
        take: 1,
        select: {
          id: true,
          reservationNumber: true,
          status: true,
          pickupAt: true,
          returnAt: true,
          customer: { select: { firstName: true, lastName: true, phone: true } },
        },
      },
    },
    orderBy: [{ status: 'asc' }, { plate: 'asc' }],
  });

  const type = vehicles[0]?.vehicleType || null;

  return res.json({
    type,
    locationId,
    vehicles: vehicles.map((v) => {
      const r = v.reservations?.[0] || null;
      const ret = r?.returnAt ? new Date(r.returnAt) : null;
      return {
        id: v.id,
        internalNumber: v.internalNumber,
        plate: v.plate || null,
        label: [v.year, v.make, v.model].filter(Boolean).join(' ') || null,
        color: v.color || null,
        mileage: num(v.mileage),
        status: v.status,
        homeLocation: v.homeLocation?.name || null,
        currentReservation: r
          ? {
              id: r.id,
              reservationNumber: r.reservationNumber || null,
              status: r.status,
              customerName: r.customer
                ? `${r.customer.firstName || ''} ${r.customer.lastName || ''}`.trim() || null
                : null,
              customerPhone: r.customer?.phone || null,
              returnAt: r.returnAt,
              returnLabel: ret ? `${dayLabel(ret, tenantTz)} · ${timeLabel(ret, tenantTz)}` : null,
              returnIso: ret ? isoDay(ret) : null,
            }
          : null,
      };
    }),
  });
}

// ---------------------------------------------------------------------------
// HTML (PDF)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pct(v) { return `${(num(v) * 100).toFixed(1)}%`; }

function renderHtml(data) {
  const { totals, types, asOfLabel } = data;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Fleet total</div><div class="strip-value">${totals.capacity}</div></div>
    <div class="strip-card heat-green"><div class="strip-label">Available now</div><div class="strip-value">${totals.AVAILABLE}</div><div style="font-size:9px;color:#173404">${pct(totals.availablePct)}</div></div>
    <div class="strip-card"><div class="strip-label">On rent</div><div class="strip-value">${totals.ON_RENT}</div><div style="font-size:9px;color:#5F5E5A">${pct(totals.onRentPct)}</div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Out of service</div><div class="strip-value">${totals.outOfServiceTotal}</div><div style="font-size:9px;color:#412402">maint. + OOS</div></div>
  </div>`;

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">As of ${escapeHtml(asOfLabel)}</p>
    <h3>By vehicle class</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Class</th>
      <th class="num">Capacity</th>
      <th class="num">Available</th>
      <th class="num">Reserved</th>
      <th class="num">On rent</th>
      <th class="num">Maint.</th>
      <th class="num">OOS</th>
    </tr></thead><tbody>`;
  for (const t of types) {
    body += `<tr>
      <td><strong>${escapeHtml(t.name)}</strong>${t.code ? ` <span style="color:#5F5E5A;font-size:8px">${escapeHtml(t.code)}</span>` : ''}</td>
      <td class="num">${t.capacity}</td>
      <td class="num heat-green">${t.counts.AVAILABLE}</td>
      <td class="num">${t.counts.RESERVED}</td>
      <td class="num">${t.counts.ON_RENT}</td>
      <td class="num">${t.counts.IN_MAINTENANCE}</td>
      <td class="num">${t.counts.OUT_OF_SERVICE}</td>
    </tr>`;
  }
  body += `<tr style="background:#f1efe8">
    <td><strong>FLEET TOTAL</strong></td>
    <td class="num"><strong>${totals.capacity}</strong></td>
    <td class="num"><strong>${totals.AVAILABLE}</strong></td>
    <td class="num"><strong>${totals.RESERVED}</strong></td>
    <td class="num"><strong>${totals.ON_RENT}</strong></td>
    <td class="num"><strong>${totals.IN_MAINTENANCE}</strong></td>
    <td class="num"><strong>${totals.OUT_OF_SERVICE}</strong></td>
  </tr></tbody></table>`;

  if (types.length === 0) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No vehicles configured for this tenant.</p>`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { types, totals, asOfLabel } = data;
  const title = 'Availability';
  const subtitle = `As of ${asOfLabel}`;

  const columns = [
    { header: 'Class',         key: 'class',          width: 22 },
    { header: 'Code',          key: 'code',           width: 10 },
    { header: 'Capacity',      key: 'capacity',       width: 10, type: 'integer' },
    { header: 'Available',     key: 'AVAILABLE',      width: 10, type: 'integer' },
    { header: 'Reserved',      key: 'RESERVED',       width: 10, type: 'integer' },
    { header: 'On rent',       key: 'ON_RENT',        width: 10, type: 'integer' },
    { header: 'Maintenance',   key: 'IN_MAINTENANCE', width: 12, type: 'integer' },
    { header: 'Out of service',key: 'OUT_OF_SERVICE', width: 14, type: 'integer' },
  ];

  return {
    title,
    subtitle,
    sheets: [{
      name: 'Availability',
      bannerRows: [[title], [subtitle]],
      columns,
      rows: types.map((t) => ({
        class: t.name,
        code: t.code || '',
        capacity: t.capacity,
        ...t.counts,
      })),
      footerRow: {
        class: 'FLEET TOTAL',
        code: '',
        capacity: totals.capacity,
        AVAILABLE: totals.AVAILABLE,
        RESERVED: totals.RESERVED,
        ON_RENT: totals.ON_RENT,
        IN_MAINTENANCE: totals.IN_MAINTENANCE,
        OUT_OF_SERVICE: totals.OUT_OF_SERVICE,
      },
    }],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'availability',
  title: 'Availability',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/type', method: 'get', handler: typeDrillDownHandler },
  ],
});

export const _availabilitySnapshotInternal = {
  computeData,
  typeDrillDownHandler,
  aggregateByType,
  VEHICLE_STATUSES,
  ACTIVE_RESERVATION_STATUSES,
  startOfDay,
  dayLabel,
};
