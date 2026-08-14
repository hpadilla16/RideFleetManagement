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

// Enum values are for the database; a printed roster is read by people.
const STATUS_LABELS = {
  AVAILABLE: 'Available',
  RESERVED: 'Reserved',
  ON_RENT: 'On rent',
  IN_MAINTENANCE: 'In maintenance',
  OUT_OF_SERVICE: 'Out of service',
};
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

  // 2026-05-28: drop SOLD + OUT_OF_SERVICE from the fleet base. SOLD
  // is terminal (vehicle sold, not coming back); OUT_OF_SERVICE is the
  // retired/totaled sink. Both already excluded by the dashboard, so
  // this report stays consistent.
  const where = { tenantId, status: { notIn: ['SOLD', 'OUT_OF_SERVICE'] } };
  if (locationId) where.homeLocationId = locationId;

  // The exports carry a full per-vehicle roster (2026-08-14, Hector), which
  // the on-screen report does not need — it has a per-class drill-down. So the
  // identifying columns are only selected when exporting, and the dashboard's
  // payload stays as small as it was.
  const isExport = String(query?._isExport || '') === '1';

  const vehicles = await prisma.vehicle.findMany({
    where,
    select: {
      id: true,
      status: true,
      vehicleType: { select: { id: true, code: true, name: true } },
      ...(isExport ? {
        plate: true,
        internalNumber: true,
        year: true,
        make: true,
        model: true,
        color: true,
        mileage: true,
        homeLocation: { select: { name: true } },
      } : {}),
    },
  });

  // 2026-05-27: Vehicle.status drifts from reality (a vehicle gets a
  // CHECKED_OUT reservation but its status row isn't flipped to ON_RENT).
  // Same fix as fleet-status: override effective status to ON_RENT when
  // an active CHECKED_OUT reservation exists for the vehicle right now.
  // Hybrid grace period (14 days). Counts CHECKED_OUT whose returnAt is
  // either in the future OR within the last 14 days. Older overdue rows
  // are assumed stale data (returned without close-out). Same definition
  // as Reports Snapshot + Fleet Status so the surfaces agree.
  const GRACE_PERIOD_DAYS = 14;
  const gracePeriodStart = new Date(asOf.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const activeReservations = await prisma.reservation.findMany({
    where: {
      tenantId,
      status: 'CHECKED_OUT',
      pickupAt: { lte: asOf },
      returnAt: { gt: gracePeriodStart },
      vehicleId: { not: null },
      // Grandfathered overdues — physically returned, exclude from
      // "on rent" so available-count agrees with the lot (2026-05-27).
      overdueIgnored: false,
      ...(locationId ? { vehicle: { homeLocationId: locationId } } : {}),
    },
    // On export, the roster says who has each car and when it is due back.
    // Widened here rather than joined per vehicle: this is already one query
    // over exactly the reservations we need, so the roster costs nothing extra.
    select: isExport
      ? {
        vehicleId: true,
        reservationNumber: true,
        returnAt: true,
        customer: { select: { firstName: true, lastName: true } },
      }
      : { vehicleId: true },
  });
  const onRentVehicleIds = new Set(activeReservations.map((r) => r.vehicleId).filter(Boolean));
  const reservationByVehicle = new Map();
  if (isExport) {
    for (const r of activeReservations) {
      if (r.vehicleId && !reservationByVehicle.has(r.vehicleId)) reservationByVehicle.set(r.vehicleId, r);
    }
  }

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
    // Export-only roster. Sorted the way someone reading a printout walks a
    // lot: class, then status, then plate. Uses the EFFECTIVE status computed
    // above, so the roster can never disagree with the counts above it — the
    // same list-vs-KPI drift this report has been bitten by before.
    vehicles: isExport
      ? vehiclesWithEffectiveStatus
        .map((v) => {
          const r = reservationByVehicle.get(v.id) || null;
          const ret = r?.returnAt ? new Date(r.returnAt) : null;
          return {
            id: v.id,
            unit: v.internalNumber || null,
            plate: v.plate || null,
            label: [v.year, v.make, v.model].filter(Boolean).join(' ') || null,
            color: v.color || null,
            mileage: num(v.mileage),
            status: v.status,
            typeCode: v.vehicleType?.code || null,
            typeName: v.vehicleType?.name || 'Unassigned',
            homeLocation: v.homeLocation?.name || null,
            reservationNumber: r?.reservationNumber || null,
            customerName: r?.customer
              ? `${r.customer.firstName || ''} ${r.customer.lastName || ''}`.trim() || null
              : null,
            dueBack: ret ? `${dayLabel(ret, tenantTz)} · ${timeLabel(ret, tenantTz)}` : null,
          };
        })
        .sort((a, b) => (a.typeName || '').localeCompare(b.typeName || '')
          || VEHICLE_STATUSES.indexOf(a.status) - VEHICLE_STATUSES.indexOf(b.status)
          || String(a.plate || '').localeCompare(String(b.plate || '')))
      : undefined,
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

  // Same SOLD/OUT_OF_SERVICE exclusion as the top-level fleet base above.
  const where = { tenantId, vehicleTypeId: typeId, status: { notIn: ['SOLD', 'OUT_OF_SERVICE'] } };
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

  // Full roster (export only). Grouped by class so the printout reads in the
  // same order as the summary above it.
  const roster = Array.isArray(data.vehicles) ? data.vehicles : [];
  if (roster.length) {
    body += `<h3 style="margin-top:18px">Every vehicle (${roster.length})</h3>
      <table style="font-size:9px"><thead><tr>
        <th style="text-align:left">Unit</th>
        <th style="text-align:left">Plate</th>
        <th style="text-align:left">Vehicle</th>
        <th style="text-align:left">Class</th>
        <th style="text-align:left">Status</th>
        <th style="text-align:left">Location</th>
        <th class="num">Mileage</th>
        <th style="text-align:left">On rent to</th>
        <th style="text-align:left">Due back</th>
      </tr></thead><tbody>`;
    let lastType = null;
    for (const v of roster) {
      if (v.typeName !== lastType) {
        lastType = v.typeName;
        body += `<tr style="background:#f1efe8"><td colspan="9"><strong>${escapeHtml(v.typeName)}</strong>${v.typeCode ? ` <span style="color:#5F5E5A;font-size:8px">${escapeHtml(v.typeCode)}</span>` : ''}</td></tr>`;
      }
      body += `<tr>
        <td>${escapeHtml(v.unit || '—')}</td>
        <td>${escapeHtml(v.plate || '—')}</td>
        <td>${escapeHtml(v.label || '—')}</td>
        <td>${escapeHtml(v.typeCode || '—')}</td>
        <td>${escapeHtml(STATUS_LABELS[v.status] || v.status)}</td>
        <td>${escapeHtml(v.homeLocation || '—')}</td>
        <td class="num">${v.mileage ? v.mileage.toLocaleString('en-US') : '—'}</td>
        <td>${escapeHtml(v.customerName || '—')}</td>
        <td>${escapeHtml(v.dueBack || '—')}</td>
      </tr>`;
    }
    body += `</tbody></table>`;
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

  const sheets = [{
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
  }];

  // Second sheet: one row per vehicle. Its own sheet rather than appended
  // below the summary, so both stay sortable and filterable in Excel.
  const roster = Array.isArray(data.vehicles) ? data.vehicles : [];
  if (roster.length) {
    sheets.push({
      name: 'Vehicles',
      bannerRows: [[`${title} — every vehicle`], [subtitle]],
      columns: [
        { header: 'Unit',        key: 'unit',       width: 12 },
        { header: 'Plate',       key: 'plate',      width: 12 },
        { header: 'Vehicle',     key: 'label',      width: 26 },
        { header: 'Class',       key: 'className',  width: 20 },
        { header: 'Code',        key: 'typeCode',   width: 10 },
        { header: 'Status',      key: 'statusText', width: 16 },
        { header: 'Location',    key: 'location',   width: 20 },
        { header: 'Color',       key: 'color',      width: 12 },
        { header: 'Mileage',     key: 'mileage',    width: 12, type: 'integer' },
        { header: 'Reservation', key: 'resNumber',  width: 16 },
        { header: 'On rent to',  key: 'customer',   width: 24 },
        { header: 'Due back',    key: 'dueBack',    width: 22 },
      ],
      rows: roster.map((v) => ({
        unit: v.unit || '',
        plate: v.plate || '',
        label: v.label || '',
        className: v.typeName || '',
        typeCode: v.typeCode || '',
        statusText: STATUS_LABELS[v.status] || v.status,
        location: v.homeLocation || '',
        color: v.color || '',
        mileage: v.mileage || 0,
        resNumber: v.reservationNumber || '',
        customer: v.customerName || '',
        dueBack: v.dueBack || '',
      })),
    });
  }

  return { title, subtitle, sheets };
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
