/**
 * Availability Forecast per Vehicle Type — Round 26 (2026-05-23).
 *
 * Powers the Hybrid frontend layout (shared headline + At a glance / Forecast
 * / Trends tabs). Adds five things on top of Round 24d:
 *
 *   1. Location filter (locationId query param)
 *      - Vehicle capacity filters by Vehicle.homeLocationId
 *      - Reservations filter by Reservation.pickupLocationId
 *      Both must align so "demand at location X" only counts cars homed at X
 *      against reservations picked up at X.
 *
 *   2. peakRisk[]
 *      One entry per day in the window where any vehicle type drops below
 *      20% available. Drives the always-visible peak-risk callout above the
 *      tabs and the bullet list inside it.
 *
 *   3. bookingPace
 *      "Lead-time curve" — at T days before pickup, what % of the day's
 *      capacity was already booked, averaged across the days in the window.
 *      Used by the Trends tab to compare current pace vs LY pace.
 *
 *   4. lastYear (conditional — only populated when compareLastYear=true)
 *      utilizationByDay + bookingPace for the SAME date range shifted back
 *      365 days. Returns hasData=false if LY has no matching reservations.
 *
 *   5. soldOutByMonth[]
 *      Last 12 months, count of days where any vehicle type was sold out.
 *      Drives the Trends-tab bar chart.
 *
 * Plus a sub-route for the click-drill side panel:
 *
 *   GET /api/reports/availability-forecast/cell?type=<id>&day=<iso>&locationId=<?>
 *     Returns the specific reservations driving demand for that type×day.
 *
 * Math (unchanged from Round 24d for the core grid):
 *   capacity[type]      = count(Vehicle where vehicleType=type, status!=RETIRED)
 *   reserved[type][day] = count(Reservation where pickupAt<=day<returnAt
 *                              and status ∈ confirmed-set)
 *   available[type][day]= max(0, capacity - reserved)
 *
 * Confirmed-set = NEW, CONFIRMED, CHECKED_OUT, IN_PROGRESS.
 */

import { registerReport } from './reports-v2.routes.js';
import { cache } from '../../lib/cache.js';
import { tenantKey } from '../../lib/cache/tenantKey.js';

const CONFIRMED_STATUSES = ['NEW', 'CONFIRMED', 'CHECKED_OUT', 'IN_PROGRESS'];
// The 12-month sold-out-by-month scan dominates this report's cost (one
// findMany + a per-day per-type bucket loop across 365+ days). The window
// is rolling-month so the result is stable for ~5 minutes between scrolls.
const SOLDOUT_CACHE_TTL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 60;
const MAX_LEAD_DAYS = 60;
const SOLDOUT_LOOKBACK_MONTHS = 12;
const PEAK_RISK_THRESHOLD = 0.20; // type below this % free counts as at-risk
const DEFAULT_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1, 0, 0, 0, 0);
}

function daysBetween(from, to) {
  return Math.max(1, Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS) + 1);
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(d, includeWeekday = true) {
  return includeWeekday
    ? `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`
    : `${MO[d.getMonth()]} ${d.getDate()}`;
}

function monthLabel(d) { return `${MO[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`; }

// ---------------------------------------------------------------------------
// Prisma resolution
// ---------------------------------------------------------------------------

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

// Build a reservation `where` clause for queries that overlap a date window.
function buildReservationWhere({ tenantId, locationId, statusList, pickupBefore, returnAfter }) {
  const where = { tenantId, status: { in: statusList }, vehicleTypeId: { not: null } };
  if (locationId) where.pickupLocationId = locationId;
  if (pickupBefore) where.pickupAt = { lt: pickupBefore };
  if (returnAfter) where.returnAt = { gt: returnAfter };
  return where;
}

// ---------------------------------------------------------------------------
// Booking pace — lead-time CDF
// ---------------------------------------------------------------------------

/**
 * For each lead-time T in [0, MAX_LEAD_DAYS], compute the average fraction of
 * daily capacity booked at least T days before pickup, across the days in
 * the window. Higher pct at large T = customers booked earlier.
 *
 * Returns { binsDaysOut, pct, sampleSize }.
 */
function computeBookingPace(reservations, days, fleetCapacity) {
  const bins = [];
  for (let t = 0; t <= MAX_LEAD_DAYS; t++) bins.push(t);
  if (fleetCapacity <= 0 || days.length === 0) {
    return { binsDaysOut: bins, pct: bins.map(() => 0), sampleSize: 0 };
  }

  // For each day index → array of lead times (one per reservation touching that day).
  const leadsByDay = new Map();
  for (const r of reservations) {
    const pickup = startOfDay(new Date(r.pickupAt));
    const ret = startOfDay(new Date(r.returnAt));
    const created = startOfDay(new Date(r.createdAt));
    const lead = Math.max(0, Math.round((pickup - created) / DAY_MS));
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      if (!(pickup <= d && d < ret)) continue;
      if (!leadsByDay.has(i)) leadsByDay.set(i, []);
      leadsByDay.get(i).push(lead);
    }
  }

  const pct = bins.map((t) => {
    let sumPct = 0;
    for (let i = 0; i < days.length; i++) {
      const leads = leadsByDay.get(i) || [];
      let booked = 0;
      for (const lead of leads) if (lead >= t) booked++;
      sumPct += booked / fleetCapacity;
    }
    return sumPct / days.length;
  });

  return { binsDaysOut: bins, pct, sampleSize: reservations.length };
}

// ---------------------------------------------------------------------------
// Sold-out by month (last 12 months)
// ---------------------------------------------------------------------------

async function computeSoldOutByMonth({ prisma, tenantId, locationId, vehicleTypes, monthsBack }) {
  // For each month in the lookback window, count days where ANY type (with
  // capacity > 0) was sold out. Honest count — months with no reservations
  // return 0 even if some types have 0 capacity.
  if (!vehicleTypes.some((vt) => vt.vehicles.length > 0)) return [];

  const now = new Date();
  const startMonth = startOfMonth(addMonths(now, -monthsBack + 1));
  const endMonth = startOfMonth(addMonths(now, 1));

  const reservations = await prisma.reservation.findMany({
    where: buildReservationWhere({
      tenantId, locationId, statusList: CONFIRMED_STATUSES,
      pickupBefore: endMonth, returnAfter: startMonth,
    }),
    select: { id: true, vehicleTypeId: true, pickupAt: true, returnAt: true },
  });

  const out = [];
  for (let m = 0; m < monthsBack; m++) {
    const monthStart = startOfMonth(addMonths(startMonth, m));
    const monthEnd = startOfMonth(addMonths(monthStart, 1));
    const daysInMonth = Math.round((monthEnd - monthStart) / DAY_MS);
    let soldOutDays = 0;
    for (let off = 0; off < daysInMonth; off++) {
      const d = addDays(monthStart, off);
      const anySoldOut = vehicleTypes.some((vt) => {
        if (vt.vehicles.length === 0) return false;
        let count = 0;
        for (const r of reservations) {
          if (r.vehicleTypeId !== vt.id) continue;
          const p = startOfDay(new Date(r.pickupAt));
          const rt = startOfDay(new Date(r.returnAt));
          if (p <= d && d < rt) count++;
        }
        return (vt.vehicles.length - count) <= 0;
      });
      if (anySoldOut) soldOutDays++;
    }
    out.push({
      yearMonth: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`,
      label: monthLabel(monthStart),
      soldOutDays,
      daysInMonth,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Last-year overlay
// ---------------------------------------------------------------------------

async function computeLastYearOverlay({ prisma, tenantId, locationId, fromDate, toDate, days, fleetCapacity }) {
  const lyFromDate = addDays(fromDate, -365);
  const lyToDate = addDays(toDate, -365);
  const lyWindowEnd = addDays(lyToDate, 1);

  const lyReservations = await prisma.reservation.findMany({
    where: buildReservationWhere({
      tenantId, locationId, statusList: CONFIRMED_STATUSES,
      pickupBefore: lyWindowEnd, returnAfter: lyFromDate,
    }),
    select: { id: true, vehicleTypeId: true, pickupAt: true, returnAt: true, createdAt: true },
  });

  const sampleSize = lyReservations.length;
  if (sampleSize === 0) {
    return { utilizationByDay: null, bookingPace: null, sampleSize: 0, hasData: false };
  }

  const lyDays = days.map((_, i) => addDays(lyFromDate, i));
  const lyReservedByDay = lyDays.map((d) => {
    let count = 0;
    for (const r of lyReservations) {
      const p = startOfDay(new Date(r.pickupAt));
      const rt = startOfDay(new Date(r.returnAt));
      if (p <= d && d < rt) count++;
    }
    return count;
  });
  const utilizationByDay = lyReservedByDay.map((c) => fleetCapacity > 0 ? c / fleetCapacity : 0);
  const bookingPace = computeBookingPace(lyReservations, lyDays, fleetCapacity);
  return { utilizationByDay, bookingPace, sampleSize, hasData: true };
}

// ---------------------------------------------------------------------------
// Main computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, from, to, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const locationId = (query && query.locationId) || null;
  const includeLastYear = query && (query.compareLastYear === 'true' || query.compareLastYear === '1');
  const includeSoldOutHistory = !query || query.includeSoldOutHistory !== 'false';

  const fromDate = from ? startOfDay(new Date(from)) : startOfDay(new Date());
  const toDate = to
    ? startOfDay(new Date(to))
    : addDays(fromDate, DEFAULT_WINDOW_DAYS - 1);
  const numDays = daysBetween(fromDate, toDate);
  const safeNumDays = Math.min(numDays, MAX_DAYS);

  const days = [];
  for (let i = 0; i < safeNumDays; i++) days.push(addDays(fromDate, i));

  // 1. Vehicle types + capacity (filtered by location if specified)
  const vehicleWhere = { status: { not: 'RETIRED' } };
  if (locationId) vehicleWhere.homeLocationId = locationId;
  const vehicleTypes = await prisma.vehicleType.findMany({
    where: { tenantId },
    select: {
      id: true, code: true, name: true,
      vehicles: { where: vehicleWhere, select: { id: true } },
    },
  });

  // 2. Confirmed reservations overlapping the window
  const windowEnd = addDays(toDate, 1);
  const reservations = await prisma.reservation.findMany({
    where: buildReservationWhere({
      tenantId, locationId, statusList: CONFIRMED_STATUSES,
      pickupBefore: windowEnd, returnAfter: fromDate,
    }),
    select: { id: true, vehicleTypeId: true, pickupAt: true, returnAt: true, createdAt: true },
  });

  // 3. Per-type daily availability
  const typesOut = vehicleTypes.map((vt) => {
    const capacity = vt.vehicles.length;
    const reservedByDay = days.map((d) => {
      let count = 0;
      for (const r of reservations) {
        if (r.vehicleTypeId !== vt.id) continue;
        const pickup = startOfDay(new Date(r.pickupAt));
        const ret = startOfDay(new Date(r.returnAt));
        if (pickup <= d && d < ret) count += 1;
      }
      return count;
    });
    const available = reservedByDay.map((r) => Math.max(0, capacity - r));
    return {
      id: vt.id, code: vt.code, name: vt.name,
      capacity, reservedByDay, availableByDay: available,
    };
  }).sort((a, b) => b.capacity - a.capacity);

  // 4. Fleet totals + peak + sold-out
  const fleetCapacity = typesOut.reduce((acc, t) => acc + t.capacity, 0);
  const fleetReservedByDay = days.map((_, i) =>
    typesOut.reduce((acc, t) => acc + (t.reservedByDay[i] || 0), 0)
  );
  const fleetAvailableByDay = days.map((_, i) => Math.max(0, fleetCapacity - fleetReservedByDay[i]));
  const utilizationByDay = days.map((_, i) => fleetCapacity > 0 ? fleetReservedByDay[i] / fleetCapacity : 0);

  let peakIdx = 0;
  for (let i = 1; i < fleetReservedByDay.length; i++) {
    if (fleetReservedByDay[i] > fleetReservedByDay[peakIdx]) peakIdx = i;
  }
  const peakDay = days[peakIdx] || fromDate;
  const peakReserved = fleetReservedByDay[peakIdx] || 0;

  const soldOutDayCount = days.reduce((acc, _, i) => {
    const anySoldOut = typesOut.some((t) => t.capacity > 0 && t.availableByDay[i] === 0);
    return acc + (anySoldOut ? 1 : 0);
  }, 0);

  const utilizationPct = (fleetCapacity > 0 && days.length > 0)
    ? Math.round((fleetReservedByDay.reduce((a, b) => a + b, 0) / (fleetCapacity * days.length)) * 100)
    : 0;

  // 5. Peak risk — days where any type drops below threshold
  const peakRisk = days.map((d, i) => {
    const atRiskTypes = typesOut
      .filter((t) => t.capacity > 0 && (t.availableByDay[i] / t.capacity) < PEAK_RISK_THRESHOLD)
      .map((t) => ({
        id: t.id, name: t.name, code: t.code,
        available: t.availableByDay[i], capacity: t.capacity,
      }));
    if (atRiskTypes.length === 0) return null;
    return {
      iso: isoDay(d), label: dayLabel(d),
      fleetAvailable: fleetAvailableByDay[i],
      fleetCapacity,
      pctFleetFree: fleetCapacity > 0
        ? Math.round((fleetAvailableByDay[i] / fleetCapacity) * 100)
        : 0,
      atRiskTypes,
    };
  }).filter(Boolean);

  // 6. Booking pace
  const bookingPace = computeBookingPace(reservations, days, fleetCapacity);

  // 7. Last year overlay (conditional)
  let lastYear = null;
  if (includeLastYear) {
    try {
      lastYear = await computeLastYearOverlay({
        prisma, tenantId, locationId, fromDate, toDate, days, fleetCapacity,
      });
    } catch (err) {
      lastYear = { utilizationByDay: null, bookingPace: null, sampleSize: 0, hasData: false, error: String(err?.message || err) };
    }
  }

  // 8. Sold-out incidence by month (last 12). Cached for 5 minutes since the
  // computation scans a year of reservations and the result barely moves
  // intra-day. Tests bypass via deps.prisma (same convention as utilization).
  let soldOutByMonth = [];
  if (includeSoldOutHistory) {
    try {
      const bypassCache = !!deps.prisma || !!deps.bypassCache;
      const compute = () => computeSoldOutByMonth({
        prisma, tenantId, locationId, vehicleTypes, monthsBack: SOLDOUT_LOOKBACK_MONTHS,
      });
      if (bypassCache) {
        soldOutByMonth = await compute();
      } else {
        const key = tenantKey(tenantId, 'reports', 'availability-forecast', 'soldout', locationId || '_');
        soldOutByMonth = await cache.getOrSet(key, compute, SOLDOUT_CACHE_TTL_MS);
      }
    } catch {
      soldOutByMonth = [];
    }
  }

  return {
    range: { from: fromDate.toISOString(), to: toDate.toISOString() },
    days: days.map((d) => ({ iso: isoDay(d), label: dayLabel(d) })),
    fleet: {
      capacity: fleetCapacity,
      reservedByDay: fleetReservedByDay,
      availableByDay: fleetAvailableByDay,
      utilizationByDay,
      utilizationPct,
      peakDay: {
        iso: isoDay(peakDay),
        label: dayLabel(peakDay),
        reserved: peakReserved,
        availableLeft: Math.max(0, fleetCapacity - peakReserved),
      },
      soldOutDayCount,
    },
    types: typesOut,
    peakRisk,
    bookingPace,
    lastYear,
    soldOutByMonth,
    filters: { locationId },
    truncated: numDays > MAX_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Cell drill-down handler — used by the click-drill side panel
// ---------------------------------------------------------------------------

async function cellDrillDownHandler(req, res, { tenantId }) {
  const prisma = await resolveDefaultPrisma();
  const typeId = (req.query?.type || req.query?.typeId || '').toString();
  const dayIso = (req.query?.day || '').toString();
  const locationId = req.query?.locationId ? String(req.query.locationId) : null;

  if (!typeId || !dayIso) {
    return res.status(400).json({ error: 'type and day query params required' });
  }

  const day = startOfDay(new Date(dayIso));
  if (Number.isNaN(day.getTime())) {
    return res.status(400).json({ error: 'day must be an ISO date (YYYY-MM-DD)' });
  }
  const dayEnd = addDays(day, 1);

  const where = {
    tenantId,
    status: { in: CONFIRMED_STATUSES },
    vehicleTypeId: typeId,
    pickupAt: { lt: dayEnd },
    returnAt: { gt: day },
  };
  if (locationId) where.pickupLocationId = locationId;

  const reservations = await prisma.reservation.findMany({
    where,
    select: {
      id: true,
      reservationNumber: true,
      status: true,
      pickupAt: true,
      returnAt: true,
      customer: { select: { firstName: true, lastName: true } },
      vehicle: { select: { plate: true, year: true, make: true, model: true } },
      pickupLocation: { select: { id: true, name: true } },
    },
    orderBy: { pickupAt: 'asc' },
  });

  let type = null;
  try {
    type = await prisma.vehicleType.findFirst({
      where: { id: typeId, tenantId },
      select: { id: true, name: true, code: true },
    });
  } catch { /* fall through */ }

  return res.json({
    type,
    day: { iso: isoDay(day), label: dayLabel(day) },
    locationId,
    reservations: reservations.map((r) => ({
      id: r.id,
      reservationNumber: r.reservationNumber,
      status: r.status,
      pickupAt: r.pickupAt,
      returnAt: r.returnAt,
      customerName: r.customer
        ? `${r.customer.firstName || ''} ${r.customer.lastName || ''}`.trim()
        : null,
      vehicle: r.vehicle
        ? {
            plate: r.vehicle.plate || null,
            label: [r.vehicle.year, r.vehicle.make, r.vehicle.model].filter(Boolean).join(' ') || null,
          }
        : null,
      pickupLocation: r.pickupLocation?.name || null,
    })),
  });
}

// ---------------------------------------------------------------------------
// HTML (PDF) rendering — kept compatible with the existing PDF layout
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function heatClass(available, capacity) {
  if (capacity <= 0) return '';
  if (available === 0) return 'heat-dark';
  const pct = available / capacity;
  if (pct < 0.2) return 'heat-red';
  if (pct < 0.5) return 'heat-amber';
  return 'heat-green';
}

function renderHtml(data) {
  const { days, fleet, types, peakRisk } = data;

  const stripHtml = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Fleet capacity</div><div class="strip-value">${fleet.capacity}</div></div>
    <div class="strip-card"><div class="strip-label">Period utilization</div><div class="strip-value">${fleet.utilizationPct}%</div></div>
    <div class="strip-card"><div class="strip-label">Peak demand</div><div class="strip-value" style="font-size:13px">${escapeHtml(fleet.peakDay.label)}<br><span style="color:#5F5E5A;font-size:10px">${fleet.peakDay.reserved}/${fleet.capacity} booked</span></div></div>
    <div class="strip-card"><div class="strip-label">Sold-out days</div><div class="strip-value">${fleet.soldOutDayCount}</div></div>
  </div>`;

  let peakRiskHtml = '';
  if (Array.isArray(peakRisk) && peakRisk.length > 0) {
    const items = peakRisk.slice(0, 8).map((pr) =>
      `<li>${escapeHtml(pr.label)} — ${pr.atRiskTypes.map((t) => `${escapeHtml(t.name)} ${t.available === 0 ? 'sold out' : `at ${t.available}`}`).join(', ')} (${pr.pctFleetFree}% fleet free)</li>`
    ).join('');
    const overflow = peakRisk.length > 8 ? `<li>…and ${peakRisk.length - 8} more</li>` : '';
    peakRiskHtml = `<h3 style="color:#791F1F">Peak risk · ${peakRisk.length} day${peakRisk.length === 1 ? '' : 's'}</h3>
      <ul style="font-size:10px; color:#501313; margin:0 0 10px 16px; padding:0">${items}${overflow}</ul>`;
  }

  let html = `${stripHtml}${peakRiskHtml}<h3>Daily availability by vehicle type</h3>
    <p style="font-size:10px;color:#5F5E5A">Cell value = units available. Green ≥50% · amber 20–50% · red &lt;20% · black sold out.</p>
    <table style="font-size:9.5px"><thead><tr>
      <th style="text-align:left">Vehicle type</th>
      <th class="num">Fleet</th>
      ${days.map((d) => `<th class="num">${escapeHtml(d.label)}</th>`).join('')}
    </tr></thead><tbody>`;
  for (const t of types) {
    html += `<tr><td><strong>${escapeHtml(t.name)}</strong><br><span style="font-size:8px;color:#5F5E5A">${escapeHtml(t.code)}</span></td>`;
    html += `<td class="num" style="color:#5F5E5A">${t.capacity}</td>`;
    for (let i = 0; i < days.length; i++) {
      const av = t.availableByDay[i];
      html += `<td class="num ${heatClass(av, t.capacity)}">${av}</td>`;
    }
    html += `</tr>`;
  }
  html += `<tr style="background:#f1efe8"><td><strong>Fleet total</strong></td>
    <td class="num"><strong>${fleet.capacity}</strong></td>
    ${days.map((_, i) => `<td class="num"><strong>${fleet.availableByDay[i]}</strong></td>`).join('')}
  </tr></tbody></table>`;

  return html;
}

// ---------------------------------------------------------------------------
// Excel — single sheet, snake-cased rows, footer for fleet totals
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { days, fleet, types, peakRisk, soldOutByMonth } = data;
  const title = 'Availability Forecast per Vehicle Type';
  const subtitle = `${data.range.from.slice(0, 10)} → ${data.range.to.slice(0, 10)}`;

  const rows = types.map((t) => {
    const r = { vehicleType: t.name, code: t.code, capacity: t.capacity };
    days.forEach((d, i) => { r[`d_${i}`] = t.availableByDay[i]; });
    return r;
  });
  const footerRow = { vehicleType: 'FLEET TOTAL', code: '', capacity: fleet.capacity };
  days.forEach((d, i) => { footerRow[`d_${i}`] = fleet.availableByDay[i]; });

  const columns = [
    { header: 'Vehicle type', key: 'vehicleType', width: 22 },
    { header: 'Code',         key: 'code',        width: 10 },
    { header: 'Capacity',     key: 'capacity',    width: 10, type: 'integer' },
    ...days.map((d, i) => ({ header: d.label, key: `d_${i}`, width: 11, type: 'integer' })),
  ];

  const sheets = [{
    name: 'Availability',
    bannerRows: [[title], [subtitle]],
    columns,
    rows,
    footerRow,
  }];

  // Secondary sheet for peak risk
  if (Array.isArray(peakRisk) && peakRisk.length > 0) {
    sheets.push({
      name: 'Peak Risk',
      bannerRows: [['Peak risk days'], [subtitle]],
      columns: [
        { header: 'Day',          key: 'day',         width: 18 },
        { header: 'Fleet free %', key: 'pctFleetFree',width: 12, type: 'integer' },
        { header: 'At-risk types',key: 'types',       width: 60 },
      ],
      rows: peakRisk.map((pr) => ({
        day: pr.label,
        pctFleetFree: pr.pctFleetFree,
        types: pr.atRiskTypes.map((t) => `${t.name} (${t.available === 0 ? 'sold out' : `${t.available} left`})`).join(', '),
      })),
    });
  }

  // Secondary sheet for sold-out incidence
  if (Array.isArray(soldOutByMonth) && soldOutByMonth.length > 0) {
    sheets.push({
      name: 'Sold-out by Month',
      bannerRows: [['Sold-out incidence (last 12 months)'], [subtitle]],
      columns: [
        { header: 'Month',         key: 'label',        width: 14 },
        { header: 'Sold-out days', key: 'soldOutDays',  width: 14, type: 'integer' },
        { header: 'Days in month', key: 'daysInMonth',  width: 14, type: 'integer' },
      ],
      rows: soldOutByMonth.map((m) => ({
        label: m.label, soldOutDays: m.soldOutDays, daysInMonth: m.daysInMonth,
      })),
    });
  }

  return { title, subtitle, sheets };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'availability-forecast',
  title: 'Availability Forecast per Vehicle Type',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/cell', method: 'get', handler: cellDrillDownHandler },
  ],
});

export const _availabilityInternal = {
  computeData,
  computeBookingPace,
  computeSoldOutByMonth,
  computeLastYearOverlay,
  cellDrillDownHandler,
  daysBetween, startOfDay, startOfMonth, addDays, addMonths, isoDay, dayLabel, monthLabel,
};
