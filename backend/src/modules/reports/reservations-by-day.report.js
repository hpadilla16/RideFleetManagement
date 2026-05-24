/**
 * Reservations by Day — Round 27 (2026-05-23).
 *
 * Daily pickup load broken out by status bucket, for the selected period.
 *
 *   GET /api/reports/reservations-by-day?from=&to=&locationId=
 *     Returns { range, days[], totals, peak, completedPickups, completedRate,
 *               cancelRate, filters, truncated }
 *
 *   GET /api/reports/reservations-by-day/day?day=<iso>&locationId=<?>
 *     Drill-down: the specific reservations with pickupAt on that day.
 *
 * "Pickup day" = Reservation.pickupAt truncated to the local day. We bucket
 * the 8 ReservationStatus enum values into 4 display buckets:
 *
 *   OPEN     = NEW · CONFIRMED · PENDING_FRANCHISE_IMPORT
 *   OUT      = CHECKED_OUT
 *   RETURNED = CHECKED_IN · CHECKED_IN_UNPAID
 *   LOST     = CANCELLED · NO_SHOW
 *
 * Default window: 1st of the current month → today (matches the legacy
 * overview default). Cap at 92 days to keep the heat-grid sized chart sane.
 */

import { registerReport } from './reports-v2.routes.js';

const STATUS_BUCKETS = {
  OPEN:     ['NEW', 'CONFIRMED', 'PENDING_FRANCHISE_IMPORT'],
  OUT:      ['CHECKED_OUT'],
  RETURNED: ['CHECKED_IN', 'CHECKED_IN_UNPAID'],
  LOST:     ['CANCELLED', 'NO_SHOW'],
};

const BUCKET_ORDER = ['OPEN', 'OUT', 'RETURNED', 'LOST'];

// Flat map status → bucket for O(1) lookup
const STATUS_TO_BUCKET = (() => {
  const out = {};
  for (const [bucket, statuses] of Object.entries(STATUS_BUCKETS)) {
    for (const s of statuses) out[s] = bucket;
  }
  return out;
})();

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 92;

// ---------------------------------------------------------------------------
// Date helpers (parallel to availability-forecast for consistency)
// ---------------------------------------------------------------------------

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

function daysBetween(from, to) {
  return Math.max(1, Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS) + 1);
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(d) {
  return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`;
}

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

// ---------------------------------------------------------------------------
// Main computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, from, to, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const locationId = (query && query.locationId) || null;

  // Default window: this month (1st → today)
  const now = new Date();
  const fromDate = from ? startOfDay(new Date(from)) : startOfMonth(now);
  const toDate = to ? startOfDay(new Date(to)) : startOfDay(now);
  const numDays = daysBetween(fromDate, toDate);
  const safeNumDays = Math.min(numDays, MAX_DAYS);
  const windowEnd = addDays(fromDate, safeNumDays); // exclusive end

  // Build day skeleton
  const days = [];
  for (let i = 0; i < safeNumDays; i++) {
    const d = addDays(fromDate, i);
    days.push({
      iso: isoDay(d),
      label: dayLabel(d),
      counts: { OPEN: 0, OUT: 0, RETURNED: 0, LOST: 0 },
      total: 0,
    });
  }
  const dayIdxByIso = new Map(days.map((d, i) => [d.iso, i]));

  // Query reservations with pickupAt in [fromDate, windowEnd)
  const where = {
    tenantId,
    pickupAt: { gte: fromDate, lt: windowEnd },
  };
  if (locationId) where.pickupLocationId = locationId;

  const reservations = await prisma.reservation.findMany({
    where,
    select: { id: true, status: true, pickupAt: true },
  });

  // Bucket each reservation into a day
  for (const r of reservations) {
    const pickup = startOfDay(new Date(r.pickupAt));
    const iso = isoDay(pickup);
    const idx = dayIdxByIso.get(iso);
    if (idx === undefined) continue;
    const bucket = STATUS_TO_BUCKET[r.status];
    if (!bucket) continue;
    days[idx].counts[bucket] += 1;
    days[idx].total += 1;
  }

  // Aggregates
  const totals = { OPEN: 0, OUT: 0, RETURNED: 0, LOST: 0, total: 0 };
  let peakIdx = 0;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    totals.OPEN     += d.counts.OPEN;
    totals.OUT      += d.counts.OUT;
    totals.RETURNED += d.counts.RETURNED;
    totals.LOST     += d.counts.LOST;
    totals.total    += d.total;
    if (d.total > days[peakIdx].total) peakIdx = i;
  }

  const peak = days[peakIdx] || { iso: isoDay(fromDate), label: dayLabel(fromDate), total: 0 };
  const completedPickups = totals.OUT + totals.RETURNED;
  const completedRate = totals.total > 0 ? completedPickups / totals.total : 0;
  const cancelRate    = totals.total > 0 ? totals.LOST / totals.total : 0;

  return {
    range: { from: fromDate.toISOString(), to: addDays(windowEnd, -1).toISOString() },
    days,
    totals,
    peak: { iso: peak.iso, label: peak.label, total: peak.total },
    completedPickups,
    completedRate,
    cancelRate,
    bucketOrder: BUCKET_ORDER,
    filters: { locationId },
    truncated: numDays > MAX_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Drill-down: reservations on a specific pickup day
// ---------------------------------------------------------------------------

async function dayDrillDownHandler(req, res, { tenantId }) {
  const prisma = await resolveDefaultPrisma();
  const dayIso = (req.query?.day || '').toString();
  const locationId = req.query?.locationId ? String(req.query.locationId) : null;

  if (!dayIso) return res.status(400).json({ error: 'day query param required' });
  const day = startOfDay(new Date(dayIso));
  if (Number.isNaN(day.getTime())) {
    return res.status(400).json({ error: 'day must be an ISO date (YYYY-MM-DD)' });
  }
  const dayEnd = addDays(day, 1);

  const where = {
    tenantId,
    pickupAt: { gte: day, lt: dayEnd },
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
      customer:   { select: { firstName: true, lastName: true } },
      vehicle:    { select: { plate: true, year: true, make: true, model: true } },
      vehicleType:{ select: { id: true, name: true, code: true } },
      pickupLocation: { select: { id: true, name: true } },
    },
    orderBy: { pickupAt: 'asc' },
  });

  return res.json({
    day: { iso: isoDay(day), label: dayLabel(day) },
    locationId,
    reservations: reservations.map((r) => ({
      id: r.id,
      reservationNumber: r.reservationNumber,
      status: r.status,
      bucket: STATUS_TO_BUCKET[r.status] || null,
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
      vehicleType: r.vehicleType?.name || null,
      pickupLocation: r.pickupLocation?.name || null,
    })),
  });
}

// ---------------------------------------------------------------------------
// HTML (PDF) rendering
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderHtml(data) {
  const { days, totals, peak, completedPickups, completedRate, cancelRate } = data;
  const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Reservations</div><div class="strip-value">${totals.total}</div></div>
    <div class="strip-card"><div class="strip-label">Completed pickups</div><div class="strip-value">${completedPickups}</div><div style="font-size:9px;color:#5F5E5A">${fmtPct(completedRate)} of total</div></div>
    <div class="strip-card"><div class="strip-label">Busiest day</div><div class="strip-value" style="font-size:13px">${escapeHtml(peak.label)}<br><span style="color:#5F5E5A;font-size:10px">${peak.total} pickups</span></div></div>
    <div class="strip-card"><div class="strip-label">Cancel + no-show</div><div class="strip-value">${fmtPct(cancelRate)}</div><div style="font-size:9px;color:#5F5E5A">${totals.LOST} of ${totals.total}</div></div>
  </div>`;

  let body = `${strip}<h3>Daily pickups by status</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Day</th>
      <th class="num">Open</th>
      <th class="num">Out</th>
      <th class="num">Returned</th>
      <th class="num">Lost</th>
      <th class="num">Total</th>
    </tr></thead><tbody>`;
  for (const d of days) {
    body += `<tr>
      <td>${escapeHtml(d.label)}</td>
      <td class="num">${d.counts.OPEN}</td>
      <td class="num">${d.counts.OUT}</td>
      <td class="num">${d.counts.RETURNED}</td>
      <td class="num">${d.counts.LOST}</td>
      <td class="num"><strong>${d.total}</strong></td>
    </tr>`;
  }
  body += `<tr style="background:#f1efe8">
    <td><strong>TOTAL</strong></td>
    <td class="num"><strong>${totals.OPEN}</strong></td>
    <td class="num"><strong>${totals.OUT}</strong></td>
    <td class="num"><strong>${totals.RETURNED}</strong></td>
    <td class="num"><strong>${totals.LOST}</strong></td>
    <td class="num"><strong>${totals.total}</strong></td>
  </tr></tbody></table>`;

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { days, totals } = data;
  const title = 'Reservations by Day';
  const subtitle = `${data.range.from.slice(0, 10)} → ${data.range.to.slice(0, 10)}`;

  const columns = [
    { header: 'Day',        key: 'day',      width: 18 },
    { header: 'Open',       key: 'OPEN',     width: 10, type: 'integer' },
    { header: 'Out',        key: 'OUT',      width: 10, type: 'integer' },
    { header: 'Returned',   key: 'RETURNED', width: 10, type: 'integer' },
    { header: 'Lost',       key: 'LOST',     width: 10, type: 'integer' },
    { header: 'Total',      key: 'total',    width: 10, type: 'integer' },
  ];

  const rows = days.map((d) => ({
    day: d.label,
    OPEN: d.counts.OPEN,
    OUT: d.counts.OUT,
    RETURNED: d.counts.RETURNED,
    LOST: d.counts.LOST,
    total: d.total,
  }));

  const footerRow = {
    day: 'TOTAL',
    OPEN: totals.OPEN,
    OUT: totals.OUT,
    RETURNED: totals.RETURNED,
    LOST: totals.LOST,
    total: totals.total,
  };

  return {
    title,
    subtitle,
    sheets: [{
      name: 'Reservations',
      bannerRows: [[title], [subtitle]],
      columns,
      rows,
      footerRow,
    }],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'reservations-by-day',
  title: 'Reservations by Day',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/day', method: 'get', handler: dayDrillDownHandler },
  ],
});

export const _reservationsByDayInternal = {
  computeData,
  dayDrillDownHandler,
  STATUS_BUCKETS,
  STATUS_TO_BUCKET,
  BUCKET_ORDER,
  startOfDay,
  startOfMonth,
  addDays,
  isoDay,
  dayLabel,
};
