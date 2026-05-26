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
import { parseDateTimeInTz, DEFAULT_TENANT_TIMEZONE } from '../../lib/date-utils.js';
import { settingsService } from '../settings/settings.service.js';

async function resolveTenantTimeZone(tenantId) {
  if (!tenantId) return DEFAULT_TENANT_TIMEZONE;
  try {
    const options = await settingsService.getReservationOptions({ tenantId });
    return String(options?.tenantTimeZone || DEFAULT_TENANT_TIMEZONE);
  } catch {
    return DEFAULT_TENANT_TIMEZONE;
  }
}

// Pickup-side buckets — applied to each reservation whose pickup day lands
// in the window. CHECKED_IN / CHECKED_IN_UNPAID still count as "picked up"
// for the pickup day (the rental did happen, the customer left the counter).
const PICKUP_STATUS_BUCKETS = {
  CONFIRMED:   ['NEW', 'CONFIRMED', 'PENDING_FRANCHISE_IMPORT'],
  CHECKED_OUT: ['CHECKED_OUT', 'CHECKED_IN', 'CHECKED_IN_UNPAID'],
  NO_SHOW:     ['CANCELLED', 'NO_SHOW'],
};
const PICKUP_BUCKET_ORDER = ['CONFIRMED', 'CHECKED_OUT', 'NO_SHOW'];
const PICKUP_STATUS_TO_BUCKET = (() => {
  const out = {};
  for (const [bucket, statuses] of Object.entries(PICKUP_STATUS_BUCKETS)) {
    for (const s of statuses) out[s] = bucket;
  }
  return out;
})();

// Return-side buckets — applied to each reservation whose return day lands
// in the window. The "expected" total counts everyone scheduled to return
// that day (any non-cancelled status); the sub-buckets split that into
// finished vs still-out so ops sees outstanding returns at a glance.
const RETURN_STATUS_BUCKETS = {
  CHECKED_IN: ['CHECKED_IN', 'CHECKED_IN_UNPAID'],
  STILL_OUT:  ['CHECKED_OUT'],
  PENDING:    ['NEW', 'CONFIRMED', 'PENDING_FRANCHISE_IMPORT'],
};
const RETURN_BUCKET_ORDER = ['CHECKED_IN', 'STILL_OUT', 'PENDING'];
const RETURN_STATUS_TO_BUCKET = (() => {
  const out = {};
  for (const [bucket, statuses] of Object.entries(RETURN_STATUS_BUCKETS)) {
    for (const s of statuses) out[s] = bucket;
  }
  return out;
})();

// 2026-05-26 Hector restructure: kept the legacy STATUS_BUCKETS export shape
// so the test file (which destructures STATUS_BUCKETS / STATUS_TO_BUCKET /
// BUCKET_ORDER from _reservationsByDayInternal) compiles. New code uses the
// PICKUP_/RETURN_ maps above; this legacy table is filled from the pickup
// side so the back-compat `counts: { OPEN, OUT, RETURNED, LOST }` field on
// each day still has data for the FE chart.
const STATUS_BUCKETS = {
  OPEN:     ['NEW', 'CONFIRMED', 'PENDING_FRANCHISE_IMPORT'],
  OUT:      ['CHECKED_OUT'],
  RETURNED: ['CHECKED_IN', 'CHECKED_IN_UNPAID'],
  LOST:     ['CANCELLED', 'NO_SHOW'],
};
const BUCKET_ORDER = ['OPEN', 'OUT', 'RETURNED', 'LOST'];
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
// Date helpers — tenant-TZ aware.
//
// The earlier version of this report used server-local helpers
// (setHours(0,0,0,0), toISOString().slice(0,10), getDay()) which under the
// UTC-running backend container assigned every reservation to its UTC day,
// not the tenant's local day. A pickup at 11 PM AST May 26 stored at
// 03:00 UTC May 27 would be bucketed into May 27 even though staff
// scheduled it for May 26.
//
// All the helpers below take a `tz` argument and use Intl to read the
// wall-clock components in that zone. PR has no DST, so adding 24h is
// equivalent to "next day"; for tenants in DST zones the +24h jump near
// the DST boundary can land on a sibling day — acceptable approximation
// for now, refactor when we onboard a DST tenant.
// ---------------------------------------------------------------------------

function tzParts(date, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
}

// "Midnight of <value> in tz" as a UTC instant. Accepts a YYYY-MM-DD
// string, a full ISO string, or a Date object.
function startOfDayInTz(value, tz) {
  if (value == null) return null;
  if (typeof value === 'string') {
    // Strip any time portion — we want midnight of the date.
    const dayOnly = value.length >= 10 ? value.slice(0, 10) : value;
    return parseDateTimeInTz(dayOnly, tz);
  }
  if (value instanceof Date) {
    const parts = tzParts(value, tz);
    return parseDateTimeInTz(`${parts.year}-${parts.month}-${parts.day}`, tz);
  }
  return null;
}

function startOfMonthInTz(date, tz) {
  const parts = tzParts(date, tz);
  return parseDateTimeInTz(`${parts.year}-${parts.month}-01`, tz);
}

function addDaysInTz(date, n) {
  // 24h-arithmetic — correct for tenants without DST. PR is UTC-4 year-round.
  return new Date(date.getTime() + n * DAY_MS);
}

function isoDayInTz(date, tz) {
  const parts = tzParts(date, tz);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayLabelInTz(date, tz) {
  // "Wed May 26" — comma stripped from Intl's default formatting.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short', month: 'short', day: 'numeric'
  }).format(date).replace(',', '');
}

// Back-compat exports for the test file (use DEFAULT_TENANT_TIMEZONE so
// behavior matches what the production tenant sees).
function startOfDay(d) { return startOfDayInTz(d, DEFAULT_TENANT_TIMEZONE); }
function startOfMonth(d) { return startOfMonthInTz(d, DEFAULT_TENANT_TIMEZONE); }
function addDays(d, n) { return addDaysInTz(d, n); }
function isoDay(d) { return isoDayInTz(d, DEFAULT_TENANT_TIMEZONE); }
function dayLabel(d) { return dayLabelInTz(d, DEFAULT_TENANT_TIMEZONE); }

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

  const tz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const locationId = (query && query.locationId) || null;

  // Default window: this month (1st → today), anchored in tenant TZ so
  // "May 2026" runs from May 1 00:00 AST → today AST midnight rather than
  // the UTC equivalents.
  const now = new Date();
  const fromDate = from ? startOfDayInTz(from, tz) : startOfMonthInTz(now, tz);
  const toDate = to ? startOfDayInTz(to, tz) : startOfDayInTz(now, tz);
  const numDays = Math.max(1, Math.round((toDate - fromDate) / DAY_MS) + 1);
  const safeNumDays = Math.min(numDays, MAX_DAYS);
  const windowEnd = addDaysInTz(fromDate, safeNumDays); // exclusive end

  // Build day skeleton — each cell labelled in tenant TZ. Carries both
  // pickup-side and return-side buckets plus the back-compat `counts`
  // shape that the FE chart still reads (filled from pickup side).
  const days = [];
  for (let i = 0; i < safeNumDays; i++) {
    const d = addDaysInTz(fromDate, i);
    days.push({
      iso: isoDayInTz(d, tz),
      label: dayLabelInTz(d, tz),
      pickup: { CONFIRMED: 0, CHECKED_OUT: 0, NO_SHOW: 0, total: 0 },
      return: { CHECKED_IN: 0, STILL_OUT: 0, PENDING: 0, total: 0 },
      // Legacy back-compat — same as pickup, mapped to old bucket names.
      counts: { OPEN: 0, OUT: 0, RETURNED: 0, LOST: 0 },
      total: 0,
    });
  }
  const dayIdxByIso = new Map(days.map((d, i) => [d.iso, i]));

  // Query reservations whose pickupAt OR returnAt fall in the window. We
  // need both ends because a rental picked up before the window can return
  // inside it (counts on the return side only) and vice versa.
  const where = {
    tenantId,
    OR: [
      { pickupAt: { gte: fromDate, lt: windowEnd } },
      { returnAt: { gte: fromDate, lt: windowEnd } },
    ],
  };
  if (locationId) where.pickupLocationId = locationId;

  const reservations = await prisma.reservation.findMany({
    where,
    select: { id: true, status: true, pickupAt: true, returnAt: true },
  });

  for (const r of reservations) {
    // Pickup side — only if the pickup day itself is in the window.
    const pickupIso = isoDayInTz(new Date(r.pickupAt), tz);
    const pickupIdx = dayIdxByIso.get(pickupIso);
    if (pickupIdx !== undefined) {
      const pBucket = PICKUP_STATUS_TO_BUCKET[r.status];
      if (pBucket) {
        days[pickupIdx].pickup[pBucket] += 1;
        days[pickupIdx].pickup.total   += 1;
      }
      // Legacy `counts` shape kept in sync for the chart.
      const legacy = STATUS_TO_BUCKET[r.status];
      if (legacy) {
        days[pickupIdx].counts[legacy] += 1;
        days[pickupIdx].total          += 1;
      }
    }

    // Return side — only if the return day itself is in the window AND the
    // reservation actually represents a return (no point counting cancelled
    // rentals as "returning"; they never went out).
    if (['CANCELLED', 'NO_SHOW'].includes(r.status)) continue;
    const returnIso = isoDayInTz(new Date(r.returnAt), tz);
    const returnIdx = dayIdxByIso.get(returnIso);
    if (returnIdx !== undefined) {
      const rBucket = RETURN_STATUS_TO_BUCKET[r.status];
      if (rBucket) {
        days[returnIdx].return[rBucket] += 1;
        days[returnIdx].return.total    += 1;
      }
    }
  }

  // Aggregates — track both sides separately so the totals row shows
  // pickup activity AND return activity for the period.
  const totals = {
    pickup: { CONFIRMED: 0, CHECKED_OUT: 0, NO_SHOW: 0, total: 0 },
    return: { CHECKED_IN: 0, STILL_OUT: 0, PENDING: 0, total: 0 },
    // Legacy back-compat (pickup-side roll-up).
    OPEN: 0, OUT: 0, RETURNED: 0, LOST: 0, total: 0,
  };
  let peakIdx = 0;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    for (const k of PICKUP_BUCKET_ORDER) totals.pickup[k] += d.pickup[k];
    totals.pickup.total += d.pickup.total;
    for (const k of RETURN_BUCKET_ORDER) totals.return[k] += d.return[k];
    totals.return.total += d.return.total;
    totals.OPEN     += d.counts.OPEN;
    totals.OUT      += d.counts.OUT;
    totals.RETURNED += d.counts.RETURNED;
    totals.LOST     += d.counts.LOST;
    totals.total    += d.total;
    if (d.total > days[peakIdx].total) peakIdx = i;
  }

  const peak = days[peakIdx] || { iso: isoDayInTz(fromDate, tz), label: dayLabelInTz(fromDate, tz), total: 0 };
  const completedPickups = totals.OUT + totals.RETURNED;
  const completedRate = totals.total > 0 ? completedPickups / totals.total : 0;
  const cancelRate    = totals.total > 0 ? totals.LOST / totals.total : 0;

  return {
    range: { from: fromDate.toISOString(), to: addDaysInTz(windowEnd, -1).toISOString() },
    days,
    totals,
    peak: { iso: peak.iso, label: peak.label, total: peak.total },
    completedPickups,
    completedRate,
    cancelRate,
    bucketOrder: BUCKET_ORDER, // legacy — for the FE chart
    pickupBucketOrder: PICKUP_BUCKET_ORDER,
    returnBucketOrder: RETURN_BUCKET_ORDER,
    tenantTimeZone: tz,
    filters: { locationId },
    truncated: numDays > MAX_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Drill-down: reservations on a specific pickup day
// ---------------------------------------------------------------------------

async function dayDrillDownHandler(req, res, { tenantId }) {
  const prisma = await resolveDefaultPrisma();
  const tz = await resolveTenantTimeZone(tenantId);
  const dayIso = (req.query?.day || '').toString();
  const locationId = req.query?.locationId ? String(req.query.locationId) : null;

  if (!dayIso) return res.status(400).json({ error: 'day query param required' });
  // Interpret the requested day in tenant TZ so the [day, dayEnd) window
  // matches the bucketing in computeData.
  const day = startOfDayInTz(dayIso, tz);
  if (!day || Number.isNaN(day.getTime())) {
    return res.status(400).json({ error: 'day must be an ISO date (YYYY-MM-DD)' });
  }
  const dayEnd = addDaysInTz(day, 1);

  // side=pickup (default) → reservations whose pickup lands on `day`.
  // side=return            → reservations whose return lands on `day`.
  // Both windows are evaluated against the same tenant-TZ [day, dayEnd).
  const side = String(req.query?.side || 'pickup').toLowerCase() === 'return' ? 'return' : 'pickup';
  const where = { tenantId };
  if (side === 'return') {
    where.returnAt = { gte: day, lt: dayEnd };
    // Cancelled / no-show rentals never return; exclude them from the
    // return drill-down so the count matches the totals row.
    where.status = { notIn: ['CANCELLED', 'NO_SHOW'] };
  } else {
    where.pickupAt = { gte: day, lt: dayEnd };
  }
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
    orderBy: side === 'return' ? { returnAt: 'asc' } : { pickupAt: 'asc' },
  });

  return res.json({
    day: { iso: isoDayInTz(day, tz), label: dayLabelInTz(day, tz) },
    side,
    locationId,
    tenantTimeZone: tz,
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

  let body = `${strip}<h3>Daily activity — pickups + returns</h3>
    <table style="font-size:9.5px"><thead>
      <tr>
        <th rowspan="2" style="text-align:left">Day</th>
        <th colspan="4" style="text-align:center;background:#eef0ff">Pickups</th>
        <th colspan="4" style="text-align:center;background:#eafff5">Returns</th>
      </tr>
      <tr>
        <th class="num">Confirmed</th>
        <th class="num">Checked out</th>
        <th class="num">No-show</th>
        <th class="num">Total</th>
        <th class="num">Due</th>
        <th class="num">Checked in</th>
        <th class="num">Still out</th>
        <th class="num">Pending</th>
      </tr>
    </thead><tbody>`;
  for (const d of days) {
    body += `<tr>
      <td>${escapeHtml(d.label)}</td>
      <td class="num">${d.pickup.CONFIRMED}</td>
      <td class="num">${d.pickup.CHECKED_OUT}</td>
      <td class="num">${d.pickup.NO_SHOW}</td>
      <td class="num"><strong>${d.pickup.total}</strong></td>
      <td class="num"><strong>${d.return.total}</strong></td>
      <td class="num">${d.return.CHECKED_IN}</td>
      <td class="num">${d.return.STILL_OUT}</td>
      <td class="num">${d.return.PENDING}</td>
    </tr>`;
  }
  body += `<tr style="background:#f1efe8">
    <td><strong>TOTAL</strong></td>
    <td class="num"><strong>${totals.pickup.CONFIRMED}</strong></td>
    <td class="num"><strong>${totals.pickup.CHECKED_OUT}</strong></td>
    <td class="num"><strong>${totals.pickup.NO_SHOW}</strong></td>
    <td class="num"><strong>${totals.pickup.total}</strong></td>
    <td class="num"><strong>${totals.return.total}</strong></td>
    <td class="num"><strong>${totals.return.CHECKED_IN}</strong></td>
    <td class="num"><strong>${totals.return.STILL_OUT}</strong></td>
    <td class="num"><strong>${totals.return.PENDING}</strong></td>
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

  // Single flat row per day — pickups on the left, returns on the right.
  const columns = [
    { header: 'Day',                key: 'day',           width: 18 },
    { header: 'Pickup Confirmed',   key: 'pickupConfirmed',   width: 14, type: 'integer' },
    { header: 'Pickup Checked-Out', key: 'pickupCheckedOut',  width: 14, type: 'integer' },
    { header: 'Pickup No-Show',     key: 'pickupNoShow',      width: 12, type: 'integer' },
    { header: 'Pickup Total',       key: 'pickupTotal',       width: 12, type: 'integer' },
    { header: 'Return Due',         key: 'returnTotal',       width: 12, type: 'integer' },
    { header: 'Return Checked-In',  key: 'returnCheckedIn',   width: 14, type: 'integer' },
    { header: 'Return Still-Out',   key: 'returnStillOut',    width: 13, type: 'integer' },
    { header: 'Return Pending',     key: 'returnPending',     width: 13, type: 'integer' },
  ];

  const rows = days.map((d) => ({
    day: d.label,
    pickupConfirmed:  d.pickup.CONFIRMED,
    pickupCheckedOut: d.pickup.CHECKED_OUT,
    pickupNoShow:     d.pickup.NO_SHOW,
    pickupTotal:      d.pickup.total,
    returnTotal:      d.return.total,
    returnCheckedIn:  d.return.CHECKED_IN,
    returnStillOut:   d.return.STILL_OUT,
    returnPending:    d.return.PENDING,
  }));

  const footerRow = {
    day: 'TOTAL',
    pickupConfirmed:  totals.pickup.CONFIRMED,
    pickupCheckedOut: totals.pickup.CHECKED_OUT,
    pickupNoShow:     totals.pickup.NO_SHOW,
    pickupTotal:      totals.pickup.total,
    returnTotal:      totals.return.total,
    returnCheckedIn:  totals.return.CHECKED_IN,
    returnStillOut:   totals.return.STILL_OUT,
    returnPending:    totals.return.PENDING,
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
