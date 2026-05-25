/**
 * Fleet Status — Round 29 (2026-05-23).
 *
 * Flat list of every vehicle with its current state. Sibling of the
 * Availability report (which rolls up by class) — this one is the detail view
 * with one row per vehicle, optionally narrowed by status / location / search.
 *
 *   GET /api/reports/fleet-status?locationId=&status=
 *     Returns { asOf, totals, vehicles[], filters, statusOrder }
 *
 * No drill-down sub-route — each row navigates directly to /vehicles/<id> on
 * the frontend. KPIs + counts are returned alongside the vehicle list so the
 * page can render the snapshot strip without a second request.
 */

import { registerReport } from './reports-v2.routes.js';

const VEHICLE_STATUSES = ['AVAILABLE', 'RESERVED', 'ON_RENT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE'];
const STATUS_LABEL = {
  AVAILABLE:      'Available',
  RESERVED:       'Reserved',
  ON_RENT:        'On rent',
  IN_MAINTENANCE: 'Maintenance',
  OUT_OF_SERVICE: 'Out of service',
};
const ACTIVE_RESERVATION_STATUSES = ['CHECKED_OUT', 'CHECKED_IN_UNPAID'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(d) { return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`; }
function timeLabel(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = ((h + 11) % 12) + 1;
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm}${ap}`;
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

function buildVehicleWhere({ tenantId, locationId, status }) {
  const where = { tenantId };
  if (locationId) where.homeLocationId = locationId;
  if (status && VEHICLE_STATUSES.includes(status)) where.status = status;
  return where;
}

// ---------------------------------------------------------------------------
// Pure projection — exposed for unit testing
// ---------------------------------------------------------------------------

/**
 * Project a prisma-shaped vehicle row into the wire-format used by the page
 * and Excel/PDF renderers.
 */
function projectVehicle(v) {
  const reservation = v.reservations?.[0] || null;
  const ret = reservation?.returnAt ? new Date(reservation.returnAt) : null;
  return {
    id: v.id,
    internalNumber: v.internalNumber,
    plate: v.plate || null,
    year: v.year || null,
    make: v.make || null,
    model: v.model || null,
    label: [v.year, v.make, v.model].filter(Boolean).join(' ') || null,
    color: v.color || null,
    mileage: num(v.mileage),
    status: v.status,
    statusLabel: STATUS_LABEL[v.status] || v.status,
    vehicleType: v.vehicleType
      ? { id: v.vehicleType.id, code: v.vehicleType.code || null, name: v.vehicleType.name || null }
      : null,
    homeLocation: v.homeLocation
      ? { id: v.homeLocation.id, name: v.homeLocation.name || null }
      : null,
    currentReservation: reservation
      ? {
          id: reservation.id,
          reservationNumber: reservation.reservationNumber || null,
          status: reservation.status,
          customerName: reservation.customer
            ? `${reservation.customer.firstName || ''} ${reservation.customer.lastName || ''}`.trim() || null
            : null,
          returnAt: reservation.returnAt,
          returnLabel: ret ? `${dayLabel(ret)} · ${timeLabel(ret)}` : null,
          returnIso: ret ? isoDay(ret) : null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const locationId = (query && query.locationId) || null;
  const status = (query && query.status && VEHICLE_STATUSES.includes(query.status)) ? query.status : null;
  const asOf = (deps && deps.now) || new Date();

  const where = buildVehicleWhere({ tenantId, locationId, status });

  const vehicles = await prisma.vehicle.findMany({
    where,
    select: {
      id: true,
      internalNumber: true,
      plate: true,
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
          returnAt: true,
          customer: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: [{ plate: 'asc' }, { internalNumber: 'asc' }],
  });

  // Always compute totals against the UNFILTERED fleet for the snapshot strip,
  // so the KPIs stay stable as the user changes status / search filters. The
  // `vehicles[]` array reflects the filter; `totalCount` is the count of that.
  //
  // 2026-05-25 (followup #17): Vehicle.status doesn't always reflect reality —
  // production data has vehicles in status=AVAILABLE that have active
  // reservations (the field isn't flipped when an agreement opens). To make
  // the On rent KPI match the per-row "Current customer" column, we derive
  // "on rent" from the existence of an active reservation, not from
  // Vehicle.status.
  const wholeFleet = status || locationId
    ? await prisma.vehicle.findMany({
        where: buildVehicleWhere({ tenantId, locationId, status: null }),
        select: {
          id: true, status: true,
          reservations: {
            where: { status: { in: ACTIVE_RESERVATION_STATUSES } },
            select: { id: true }, take: 1,
          },
        },
      })
    : vehicles.map((v) => ({ id: v.id, status: v.status, reservations: v.reservations }));

  const totals = {
    capacity: wholeFleet.length,
    AVAILABLE: 0, RESERVED: 0, ON_RENT: 0, IN_MAINTENANCE: 0, OUT_OF_SERVICE: 0,
  };
  for (const v of wholeFleet) {
    const hasActive = Array.isArray(v.reservations) && v.reservations.length > 0;
    let effective = v.status;
    if (hasActive && (effective === 'AVAILABLE' || effective === 'RESERVED')) {
      effective = 'ON_RENT';
    }
    if (VEHICLE_STATUSES.includes(effective)) totals[effective] += 1;
    else totals.OUT_OF_SERVICE += 1;
  }
  totals.outOfServiceTotal = totals.IN_MAINTENANCE + totals.OUT_OF_SERVICE;
  totals.availablePct = totals.capacity > 0 ? totals.AVAILABLE / totals.capacity : 0;
  totals.onRentPct    = totals.capacity > 0 ? totals.ON_RENT / totals.capacity : 0;

  const projected = vehicles.map(projectVehicle);

  return {
    asOf: asOf.toISOString(),
    asOfLabel: `${dayLabel(asOf)} · ${timeLabel(asOf)}`,
    totals,
    vehicles: projected,
    totalCount: projected.length,
    statusOrder: VEHICLE_STATUSES,
    statusLabels: STATUS_LABEL,
    filters: { locationId, status },
  };
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
  const { totals, vehicles, asOfLabel, filters } = data;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Fleet total</div><div class="strip-value">${totals.capacity}</div></div>
    <div class="strip-card heat-green"><div class="strip-label">Available</div><div class="strip-value">${totals.AVAILABLE}</div><div style="font-size:9px;color:#173404">${pct(totals.availablePct)}</div></div>
    <div class="strip-card"><div class="strip-label">On rent</div><div class="strip-value">${totals.ON_RENT}</div><div style="font-size:9px;color:#5F5E5A">${pct(totals.onRentPct)}</div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Out of service</div><div class="strip-value">${totals.outOfServiceTotal}</div></div>
  </div>`;

  const filterNote = filters.status ? ` · filtered to ${escapeHtml(STATUS_LABEL[filters.status] || filters.status)}` : '';

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">As of ${escapeHtml(asOfLabel)} · ${vehicles.length} vehicle${vehicles.length === 1 ? '' : 's'}${filterNote}</p>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Plate</th>
      <th style="text-align:left">Vehicle</th>
      <th style="text-align:left">Class</th>
      <th class="num">Mileage</th>
      <th style="text-align:left">Location</th>
      <th style="text-align:left">Status</th>
      <th style="text-align:left">Current customer</th>
    </tr></thead><tbody>`;
  for (const v of vehicles) {
    const vehLabel = v.label ? `${v.label}${v.color ? ` · ${v.color}` : ''}` : (v.color || '—');
    const customer = v.currentReservation
      ? `${escapeHtml(v.currentReservation.customerName || '(no customer)')} · ${escapeHtml(v.currentReservation.returnLabel || '')}`
      : '—';
    body += `<tr>
      <td><strong>${escapeHtml(v.plate || '—')}</strong></td>
      <td>${escapeHtml(vehLabel)}</td>
      <td>${escapeHtml(v.vehicleType?.name || '—')}</td>
      <td class="num">${v.mileage > 0 ? v.mileage.toLocaleString() : '—'}</td>
      <td>${escapeHtml(v.homeLocation?.name || '—')}</td>
      <td>${escapeHtml(v.statusLabel)}</td>
      <td>${customer}</td>
    </tr>`;
  }
  body += `</tbody></table>`;

  if (vehicles.length === 0) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No vehicles match the current filters.</p>`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { vehicles, asOfLabel, filters } = data;
  const title = 'Fleet Status';
  const subtitle = `As of ${asOfLabel}${filters.status ? ` · ${STATUS_LABEL[filters.status] || filters.status}` : ''}`;

  return {
    title,
    subtitle,
    sheets: [{
      name: 'Fleet',
      bannerRows: [[title], [subtitle]],
      columns: [
        { header: 'Plate',          key: 'plate',         width: 10 },
        { header: 'Internal #',     key: 'internal',      width: 12 },
        { header: 'Year',           key: 'year',          width: 8,  type: 'integer' },
        { header: 'Make',           key: 'make',          width: 14 },
        { header: 'Model',          key: 'model',         width: 14 },
        { header: 'Color',          key: 'color',         width: 10 },
        { header: 'Class',          key: 'class',         width: 14 },
        { header: 'Mileage',        key: 'mileage',       width: 12, type: 'integer' },
        { header: 'Location',       key: 'location',      width: 18 },
        { header: 'Status',         key: 'status',        width: 14 },
        { header: 'Customer',       key: 'customer',      width: 22 },
        { header: 'Return',         key: 'returnLabel',   width: 22 },
        { header: 'Reservation',    key: 'reservation',   width: 14 },
      ],
      rows: vehicles.map((v) => ({
        plate: v.plate || '',
        internal: v.internalNumber || '',
        year: v.year || '',
        make: v.make || '',
        model: v.model || '',
        color: v.color || '',
        class: v.vehicleType?.name || '',
        mileage: v.mileage,
        location: v.homeLocation?.name || '',
        status: v.statusLabel,
        customer: v.currentReservation?.customerName || '',
        returnLabel: v.currentReservation?.returnLabel || '',
        reservation: v.currentReservation?.reservationNumber || '',
      })),
    }],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'fleet-status',
  title: 'Fleet Status',
  computeData,
  renderHtml,
  buildExcelSpec,
});

export const _fleetStatusInternal = {
  computeData,
  projectVehicle,
  VEHICLE_STATUSES,
  STATUS_LABEL,
  ACTIVE_RESERVATION_STATUSES,
};
