/**
 * Availability Forecast per Vehicle Type — Round 24d (2026-05-22).
 *
 * For each vehicle type in the tenant's catalog, compute day-by-day
 * available inventory across the selected date range based on confirmed
 * reservations.
 *
 * Math:
 *   capacity[type]            = count(Vehicle where vehicleType = type and status != RETIRED)
 *   reserved[type][day]       = count(Reservation where vehicleType = type
 *                                     and pickupAt <= day < returnAt
 *                                     and status in confirmed-set)
 *   available[type][day]      = max(0, capacity - reserved)
 *
 * "Confirmed set" = NEW, CONFIRMED, CHECKED_OUT, IN_PROGRESS (anything not
 * cancelled / no-show / returned). This conservative count gives the agent
 * an honest "what's actually available" view.
 */

import { registerReport } from './reports-v2.routes.js';

const CONFIRMED_STATUSES = ['NEW', 'CONFIRMED', 'CHECKED_OUT', 'IN_PROGRESS'];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function daysBetween(from, to) {
  return Math.max(1, Math.round((startOfDay(to) - startOfDay(from)) / (24 * 60 * 60 * 1000)) + 1);
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

function dayLabel(d, includeWeekday = true) {
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  if (includeWeekday) return `${wd} ${mo} ${d.getDate()}`;
  return `${mo} ${d.getDate()}`;
}

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

async function computeData({ tenantId, from, to }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const fromDate = from ? startOfDay(new Date(from)) : startOfDay(new Date());
  const toDate = to ? startOfDay(new Date(to)) : addDays(fromDate, 13); // default 14-day window
  const numDays = daysBetween(fromDate, toDate);

  // Cap at 60 days to keep the table from blowing up
  const safeNumDays = Math.min(numDays, 60);
  const days = [];
  for (let i = 0; i < safeNumDays; i++) {
    days.push(addDays(fromDate, i));
  }

  // 1. Load vehicle types + capacity
  const vehicleTypes = await prisma.vehicleType.findMany({
    where: { tenantId },
    select: {
      id: true, code: true, name: true,
      vehicles: {
        where: { status: { not: 'RETIRED' } },
        select: { id: true },
      },
    },
  });

  // 2. Load confirmed reservations overlapping the window
  const windowEnd = addDays(toDate, 1); // inclusive end of last day
  const reservations = await prisma.reservation.findMany({
    where: {
      tenantId,
      status: { in: CONFIRMED_STATUSES },
      pickupAt: { lt: windowEnd },
      returnAt: { gt: fromDate },
      vehicleTypeId: { not: null },
    },
    select: { id: true, vehicleTypeId: true, pickupAt: true, returnAt: true },
  });

  // 3. For each vehicle type, compute capacity + per-day reserved counts
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
      id: vt.id,
      code: vt.code,
      name: vt.name,
      capacity,
      reservedByDay,
      availableByDay: available,
    };
  }).sort((a, b) => b.capacity - a.capacity);

  // 4. Fleet totals + peak/sold-out
  const fleetCapacity = typesOut.reduce((acc, t) => acc + t.capacity, 0);
  const fleetReservedByDay = days.map((_, i) =>
    typesOut.reduce((acc, t) => acc + (t.reservedByDay[i] || 0), 0)
  );
  const fleetAvailableByDay = days.map((_, i) => Math.max(0, fleetCapacity - fleetReservedByDay[i]));

  // Peak demand day = day with highest reserved count
  let peakIdx = 0;
  for (let i = 1; i < fleetReservedByDay.length; i++) {
    if (fleetReservedByDay[i] > fleetReservedByDay[peakIdx]) peakIdx = i;
  }
  const peakDay = days[peakIdx];
  const peakReserved = fleetReservedByDay[peakIdx];

  // Sold-out days = days where ANY vehicle type hit 0 available with capacity > 0
  const soldOutDays = days.reduce((acc, _, i) => {
    const anySoldOut = typesOut.some((t) => t.capacity > 0 && t.availableByDay[i] === 0);
    return acc + (anySoldOut ? 1 : 0);
  }, 0);

  // Period utilization = sum(reserved) / (capacity * days)
  const utilizationPct = (fleetCapacity > 0 && days.length > 0)
    ? Math.round((fleetReservedByDay.reduce((a, b) => a + b, 0) / (fleetCapacity * days.length)) * 100)
    : 0;

  return {
    range: { from: fromDate.toISOString(), to: toDate.toISOString() },
    days: days.map((d) => ({ iso: isoDay(d), label: dayLabel(d) })),
    fleet: {
      capacity: fleetCapacity,
      reservedByDay: fleetReservedByDay,
      availableByDay: fleetAvailableByDay,
      utilizationPct,
      peakDay: {
        iso: isoDay(peakDay),
        label: dayLabel(peakDay),
        reserved: peakReserved,
        availableLeft: Math.max(0, fleetCapacity - peakReserved),
      },
      soldOutDayCount: soldOutDays,
    },
    types: typesOut,
    truncated: numDays > 60,
  };
}

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
  const { days, fleet, types } = data;

  const stripHtml = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Fleet capacity</div><div class="strip-value">${fleet.capacity}</div></div>
    <div class="strip-card"><div class="strip-label">Period utilization</div><div class="strip-value">${fleet.utilizationPct}%</div></div>
    <div class="strip-card"><div class="strip-label">Peak demand</div><div class="strip-value" style="font-size:13px">${escapeHtml(fleet.peakDay.label)}<br><span style="color:#5F5E5A;font-size:10px">${fleet.peakDay.reserved}/${fleet.capacity} booked</span></div></div>
    <div class="strip-card"><div class="strip-label">Sold-out days</div><div class="strip-value">${fleet.soldOutDayCount}</div></div>
  </div>`;

  let html = `${stripHtml}<h3>Daily availability by vehicle type</h3>
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

function buildExcelSpec(data) {
  const { days, fleet, types } = data;
  const title = 'Availability Forecast per Vehicle Type';
  const subtitle = `${data.range.from.slice(0, 10)} → ${data.range.to.slice(0, 10)}`;

  // One row per vehicle type, one column per day
  const rows = types.map((t) => {
    const r = { vehicleType: t.name, code: t.code, capacity: t.capacity };
    days.forEach((d, i) => { r[`d_${i}`] = t.availableByDay[i]; });
    return r;
  });
  // Footer row: fleet total
  const footerRow = { vehicleType: 'FLEET TOTAL', code: '', capacity: fleet.capacity };
  days.forEach((d, i) => { footerRow[`d_${i}`] = fleet.availableByDay[i]; });

  const columns = [
    { header: 'Vehicle type', key: 'vehicleType', width: 22 },
    { header: 'Code',         key: 'code',        width: 10 },
    { header: 'Capacity',     key: 'capacity',    width: 10, type: 'integer' },
    ...days.map((d, i) => ({ header: d.label, key: `d_${i}`, width: 11, type: 'integer' })),
  ];

  return {
    title,
    subtitle,
    sheets: [
      {
        name: 'Availability',
        bannerRows: [[title], [subtitle]],
        columns,
        rows,
        footerRow,
      },
    ],
  };
}

// ---------------------------------------------------------------------------

registerReport({
  slug: 'availability-forecast',
  title: 'Availability Forecast per Vehicle Type',
  computeData,
  renderHtml,
  buildExcelSpec,
});

export const _availabilityInternal = { computeData, daysBetween, startOfDay, addDays, isoDay, dayLabel };
