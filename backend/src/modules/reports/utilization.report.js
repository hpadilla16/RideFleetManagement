/**
 * Utilization — Round 29 (2026-05-23).
 *
 * Historical fleet utilization over a date range. Sibling of availability-
 * forecast's Trends tab, but BACKWARD-looking (completed + active rentals)
 * rather than forward-looking (confirmed but not yet started).
 *
 *   GET /api/reports/utilization?from=&to=&locationId=&compareLastYear=
 *     Returns { range, granularity, fleet, byType[], lastYear?, filters }
 *
 * Granularity auto-switches based on range size:
 *   ≤ 60 days   → daily      (label "Sat May 23")
 *   ≤ 365 days  → weekly     (label "Week of May 18")
 *   > 365 days  → monthly    (label "May 2026")
 *
 * Cap at 730 days (2 years) — beyond that the page must narrow the window.
 *
 * Utilization is computed as "rental-days / (capacity × days)" per bucket:
 *   - For each day in the window, count active reservations (per type and
 *     fleet-wide), divide by capacity.
 *   - For weekly/monthly, average the daily fractions across the bucket.
 *
 * Active = any reservation in {NEW, CONFIRMED, CHECKED_OUT, CHECKED_IN,
 * CHECKED_IN_UNPAID}. Excludes CANCELLED, NO_SHOW, PENDING_FRANCHISE_IMPORT.
 */

import { registerReport } from './reports-v2.routes.js';
import {
  DEFAULT_TENANT_TIMEZONE,
  startOfDayInTz,
  startOfMonthInTz,
  addDaysInTz,
  addMonthsInTz,
  isoDayInTz,
  dayLabelInTz,
} from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';
import { cache } from '../../lib/cache.js';
import { tenantKey } from '../../lib/cache/tenantKey.js';

// HISTORICAL utilization — only rentals that actually happened. NEW /
// CONFIRMED are future-planned reservations and don't represent a physical
// rental yet; including them previously inflated past-window utilization
// and produced impossible >100% values when CONFIRMED future reservations
// overlapped with currently-checked-out rentals on the same vehicle type.
const ACTIVE_STATUSES = ['CHECKED_OUT', 'CHECKED_IN', 'CHECKED_IN_UNPAID'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 730;
// Utilization scans up to 2 years of reservations × current capacity grid. The
// query is ~50–200ms on Hector's prod size but scales linearly with reservation
// count, so cache the whole result for 5 minutes. Tests bypass the cache by
// passing `deps.prisma` (since they want their fake prisma exercised, not a
// cached value from a previous test).
const CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// 2026-05-26: tz-aware date helpers. These default-shadow helpers exist for
// callers that don't have a resolved tenantTz handy (e.g. tests that pass
// no tenant). computeData shadows these inside its own closure with the
// resolved tenantTz so per-tenant timezones are honored end-to-end.
function startOfDay(d, tz = DEFAULT_TENANT_TIMEZONE)   { return startOfDayInTz(d, tz); }
function startOfMonth(d, tz = DEFAULT_TENANT_TIMEZONE) { return startOfMonthInTz(d, tz); }
function addDays(d, n)                                  { return addDaysInTz(d, n); }
function addMonths(d, n, tz = DEFAULT_TENANT_TIMEZONE) { return addMonthsInTz(d, n, tz); }
function isoDay(d, tz = DEFAULT_TENANT_TIMEZONE)       { return isoDayInTz(d, tz); }
function dayLabel(d, tz = DEFAULT_TENANT_TIMEZONE)     { return dayLabelInTz(d, tz); }

// Week-start helper — anchored to tenant-TZ Monday midnight. We floor to
// tenant-TZ midnight first; the resulting Date carries the UTC weekday for
// that wall-clock instant. Subtract offset days to land on Monday. PR has no
// DST so 24h math is correct; tenants in DST zones bias the offset by their
// fixed weekday at tenant midnight.
function startOfIsoWeek(d, tz = DEFAULT_TENANT_TIMEZONE) {
  const dayStart = startOfDay(d, tz);
  const wd = dayStart.getUTCDay(); // 0=Sun..6=Sat
  const offset = (wd + 6) % 7;     // 0 if Monday
  return addDays(dayStart, -offset);
}

function daysBetween(from, to, tz = DEFAULT_TENANT_TIMEZONE) {
  return Math.max(1, Math.round((startOfDay(to, tz) - startOfDay(from, tz)) / DAY_MS) + 1);
}

function weekLabel(d, tz = DEFAULT_TENANT_TIMEZONE)  {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
  return `Week of ${parts.replace(',', '')}`;
}
function monthLabel(d, tz = DEFAULT_TENANT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', year: 'numeric' }).format(d);
  return parts.replace(',', '');
}

// ---------------------------------------------------------------------------
// Granularity
// ---------------------------------------------------------------------------

function pickGranularity(rangeDays) {
  if (rangeDays <= 60)  return 'day';
  if (rangeDays <= 365) return 'week';
  return 'month';
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
// Core math — exposed for unit testing
// ---------------------------------------------------------------------------

/**
 * Walk reservations and produce per-day {fleetReserved, byType[reserved]} maps.
 * Returns arrays of length `days.length`. Pure function — no prisma.
 *
 *   days:        Date[] (day-start timestamps in order)
 *   typeIds:     string[] (vehicle type ids in order matching capacity array)
 *   reservations: [{ vehicleId, vehicleTypeId, pickupAt, returnAt }]
 *
 * Dedup: counts each (vehicleId, day) pair at most once. If a single
 * vehicle has multiple overlapping reservations (back-to-back with a
 * small overlap, data import quirks), it can't physically be rented
 * twice on the same day. Without this dedup, overlapping reservations
 * pushed Minivan capacity past 100% (37 rental-days for 5 cars × 7 days
 * = 105.7%). Reservations missing vehicleId (still in NEW/CONFIRMED
 * with no vehicle assigned) are no longer in scope per the status
 * filter, so the dedup key is reliable.
 */
function buildDailyCounts(days, typeIds, reservations, tz = DEFAULT_TENANT_TIMEZONE) {
  const fleetReserved = new Array(days.length).fill(0);
  const typeReserved = typeIds.map(() => new Array(days.length).fill(0));
  const typeIdx = new Map(typeIds.map((id, i) => [id, i]));
  // Per-day set of vehicleIds already counted, indexed by day index.
  const countedByDay = days.map(() => new Set());

  for (const r of reservations) {
    const pickup = startOfDay(new Date(r.pickupAt), tz);
    const ret = startOfDay(new Date(r.returnAt), tz);
    const ti = typeIdx.get(r.vehicleTypeId);
    const vid = r.vehicleId || null;
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      if (pickup <= d && d < ret) {
        // Skip if this vehicle was already counted for this day.
        if (vid) {
          if (countedByDay[i].has(vid)) continue;
          countedByDay[i].add(vid);
        }
        fleetReserved[i] += 1;
        if (ti !== undefined) typeReserved[ti][i] += 1;
      }
    }
  }
  return { fleetReserved, typeReserved };
}

/**
 * Bucket a day-indexed series into weekly or monthly buckets. Returns an
 * array of { iso, label, daysInBucket, sumReserved } objects.
 */
function bucketDailySeries(days, fleetReserved, granularity, tz = DEFAULT_TENANT_TIMEZONE) {
  if (granularity === 'day') {
    return days.map((d, i) => ({
      iso: isoDay(d, tz),
      label: dayLabel(d, tz),
      daysInBucket: 1,
      sumReserved: fleetReserved[i],
    }));
  }

  const buckets = [];
  let cursor = null;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const key = granularity === 'week' ? startOfIsoWeek(d, tz) : startOfMonth(d, tz);
    if (!cursor || cursor.key.getTime() !== key.getTime()) {
      cursor = {
        key,
        iso: isoDay(key, tz),
        label: granularity === 'week' ? weekLabel(key, tz) : monthLabel(key, tz),
        daysInBucket: 0,
        sumReserved: 0,
      };
      buckets.push(cursor);
    }
    cursor.daysInBucket += 1;
    cursor.sumReserved += fleetReserved[i];
  }
  // Drop the closure key from the output
  return buckets.map(({ key: _k, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData(params, deps = {}) {
  if (!params?.tenantId) throw new Error('tenantId required');
  // Tests pass deps.prisma to exercise their fake — never use the cache in
  // that path so each test sees its own fixture. Production callers (the
  // route handler) never set deps.prisma, so they always benefit from the
  // 5-minute cache.
  const bypassCache = !!deps.prisma || !!deps.bypassCache;
  if (bypassCache) return computeDataInner(params, deps);

  const { tenantId, from, to, query } = params;
  const locationId = (query && query.locationId) || null;
  const includeLastYear = query && (query.compareLastYear === 'true' || query.compareLastYear === '1');
  const key = tenantKey(
    tenantId, 'reports', 'utilization',
    from || 'default',
    to || 'default',
    locationId || '_',
    includeLastYear ? 'ly' : 'no-ly',
  );
  return cache.getOrSet(key, () => computeDataInner(params, deps), CACHE_TTL_MS);
}

async function computeDataInner({ tenantId, from, to, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());

  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  // Shadow the module-level helpers with tenantTz-bound versions so the rest
  // of computeData and its callees naturally honor the tenant's timezone.
  const startOfDay   = (d)    => startOfDayInTz(d, tenantTz);
  const startOfMonth = (d)    => startOfMonthInTz(d, tenantTz);
  const addDays      = (d, n) => addDaysInTz(d, n);

  const locationId = (query && query.locationId) || null;
  const includeLastYear = query && (query.compareLastYear === 'true' || query.compareLastYear === '1');

  const now = (deps && deps.now) || new Date();
  // Default range: last 30 days ending today
  // Raw query strings → tenant-TZ midnight (don't wrap in new Date first).
  const fromDate = from ? startOfDay(from) : addDays(startOfDay(now), -29);
  const toDate   = to   ? startOfDay(to)   : startOfDay(now);
  const rangeDays = daysBetween(fromDate, toDate, tenantTz);
  const safeRangeDays = Math.min(rangeDays, MAX_DAYS);
  const truncated = rangeDays > MAX_DAYS;

  const days = [];
  for (let i = 0; i < safeRangeDays; i++) days.push(addDays(fromDate, i));
  const windowEnd = addDays(fromDate, safeRangeDays);
  const granularity = pickGranularity(safeRangeDays);

  // Vehicle types + capacity (current snapshot — approximation for the window)
  const vehicleWhere = {};
  if (locationId) vehicleWhere.homeLocationId = locationId;

  const vehicleTypes = await prisma.vehicleType.findMany({
    where: { tenantId },
    select: {
      id: true, code: true, name: true,
      vehicles: { where: vehicleWhere, select: { id: true } },
    },
  });

  const typeIds = vehicleTypes.map((vt) => vt.id);
  const capacityById = new Map(vehicleTypes.map((vt) => [vt.id, vt.vehicles.length]));
  const fleetCapacity = vehicleTypes.reduce((acc, vt) => acc + vt.vehicles.length, 0);

  // Active reservations overlapping the window
  const reservations = await loadActiveReservations({
    prisma, tenantId, locationId, fromDate, windowEnd,
  });

  // Per-day counts (fleet + per-type)
  const { fleetReserved, typeReserved } = buildDailyCounts(days, typeIds, reservations, tenantTz);

  // Bucket into the chosen granularity
  const rawBuckets = bucketDailySeries(days, fleetReserved, granularity, tenantTz);
  const buckets = rawBuckets.map((b) => ({
    iso: b.iso,
    label: b.label,
    daysInBucket: b.daysInBucket,
    utilization: fleetCapacity > 0 ? b.sumReserved / (fleetCapacity * b.daysInBucket) : 0,
  }));

  // Window-wide averages and peaks
  const totalUnitDays = fleetReserved.reduce((acc, n) => acc + n, 0);
  const capacityUnitDays = fleetCapacity * days.length;
  const averageUtilization = capacityUnitDays > 0 ? totalUnitDays / capacityUnitDays : 0;

  let peakBucket = null;
  let troughBucket = null;
  for (const b of buckets) {
    if (!peakBucket   || b.utilization > peakBucket.utilization)   peakBucket   = b;
    if (!troughBucket || b.utilization < troughBucket.utilization) troughBucket = b;
  }

  // Per-type window utilization
  const byType = vehicleTypes
    .map((vt, ti) => {
      const cap = vt.vehicles.length;
      const reserved = typeReserved[ti].reduce((acc, n) => acc + n, 0);
      return {
        id: vt.id,
        code: vt.code || null,
        name: vt.name,
        capacity: cap,
        rentalDays: reserved,
        utilizationPct: cap > 0 ? reserved / (cap * days.length) : 0,
      };
    })
    .sort((a, b) => b.utilizationPct - a.utilizationPct);

  // Last year overlay (conditional)
  let lastYear = null;
  if (includeLastYear) {
    try {
      lastYear = await computeLastYear({
        prisma, tenantId, locationId, fromDate, days, granularity, fleetCapacity, typeIds, tenantTz,
      });
    } catch (err) {
      lastYear = { buckets: null, averageUtilization: null, sampleSize: 0, hasData: false, error: String(err?.message || err) };
    }
  }

  return {
    range: { from: fromDate.toISOString(), to: addDays(windowEnd, -1).toISOString() },
    granularity,
    rangeDays: safeRangeDays,
    truncated,
    tenantTimeZone: tenantTz,
    fleet: {
      capacity: fleetCapacity,
      buckets,
      averageUtilization,
      totalRentalDays: totalUnitDays,
      capacityUnitDays,
      peakBucket: peakBucket && { iso: peakBucket.iso, label: peakBucket.label, utilization: peakBucket.utilization },
      troughBucket: troughBucket && { iso: troughBucket.iso, label: troughBucket.label, utilization: troughBucket.utilization },
    },
    byType,
    lastYear,
    filters: { locationId },
  };
}

async function loadActiveReservations({ prisma, tenantId, locationId, fromDate, windowEnd }) {
  const where = {
    tenantId,
    status: { in: ACTIVE_STATUSES },
    vehicleTypeId: { not: null },
    pickupAt: { lt: windowEnd },
    returnAt: { gt: fromDate },
  };
  if (locationId) where.pickupLocationId = locationId;
  return prisma.reservation.findMany({
    where,
    select: { id: true, vehicleId: true, vehicleTypeId: true, pickupAt: true, returnAt: true },
  });
}

async function computeLastYear({ prisma, tenantId, locationId, fromDate, days, granularity, fleetCapacity, typeIds, tenantTz = DEFAULT_TENANT_TIMEZONE }) {
  const lyFrom = addDays(fromDate, -365);
  const lyEnd = addDays(lyFrom, days.length);
  const lyDays = days.map((_, i) => addDays(lyFrom, i));

  const reservations = await loadActiveReservations({
    prisma, tenantId, locationId, fromDate: lyFrom, windowEnd: lyEnd,
  });
  const sampleSize = reservations.length;
  if (sampleSize === 0) {
    return { buckets: null, averageUtilization: null, sampleSize: 0, hasData: false };
  }

  const { fleetReserved } = buildDailyCounts(lyDays, typeIds, reservations, tenantTz);
  const rawBuckets = bucketDailySeries(lyDays, fleetReserved, granularity, tenantTz);
  const buckets = rawBuckets.map((b) => ({
    iso: b.iso,
    label: b.label,
    daysInBucket: b.daysInBucket,
    utilization: fleetCapacity > 0 ? b.sumReserved / (fleetCapacity * b.daysInBucket) : 0,
  }));
  const totalUnitDays = fleetReserved.reduce((acc, n) => acc + n, 0);
  const averageUtilization = fleetCapacity > 0 && lyDays.length > 0
    ? totalUnitDays / (fleetCapacity * lyDays.length)
    : 0;
  return { buckets, averageUtilization, sampleSize, hasData: true };
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
  const { fleet, byType, granularity, range } = data;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Average utilization</div><div class="strip-value">${pct(fleet.averageUtilization)}</div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Peak bucket</div><div class="strip-value" style="font-size:13px">${escapeHtml(fleet.peakBucket?.label || '—')}<br><span style="font-size:10px;color:#412402">${fleet.peakBucket ? pct(fleet.peakBucket.utilization) : ''}</span></div></div>
    <div class="strip-card heat-green"><div class="strip-label">Trough bucket</div><div class="strip-value" style="font-size:13px">${escapeHtml(fleet.troughBucket?.label || '—')}<br><span style="font-size:10px;color:#173404">${fleet.troughBucket ? pct(fleet.troughBucket.utilization) : ''}</span></div></div>
    <div class="strip-card"><div class="strip-label">Rental days</div><div class="strip-value">${fleet.totalRentalDays.toLocaleString()}</div><div style="font-size:9px;color:#5F5E5A">of ${fleet.capacityUnitDays.toLocaleString()} capacity-days</div></div>
  </div>`;

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">${escapeHtml(range.from.slice(0,10))} → ${escapeHtml(range.to.slice(0,10))} · granularity: ${granularity}</p>
    <h3>Utilization by ${granularity}</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">${granularity === 'day' ? 'Day' : granularity === 'week' ? 'Week' : 'Month'}</th>
      <th class="num">Utilization</th>
    </tr></thead><tbody>`;
  for (const b of fleet.buckets) {
    body += `<tr><td>${escapeHtml(b.label)}</td><td class="num">${pct(b.utilization)}</td></tr>`;
  }
  body += `</tbody></table>`;

  body += `<h3>By vehicle class</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Class</th>
      <th class="num">Capacity</th>
      <th class="num">Rental days</th>
      <th class="num">Utilization</th>
    </tr></thead><tbody>`;
  for (const t of byType) {
    body += `<tr>
      <td><strong>${escapeHtml(t.name)}</strong>${t.code ? ` <span style="color:#5F5E5A;font-size:8px">${escapeHtml(t.code)}</span>` : ''}</td>
      <td class="num">${t.capacity}</td>
      <td class="num">${t.rentalDays.toLocaleString()}</td>
      <td class="num"><strong>${pct(t.utilizationPct)}</strong></td>
    </tr>`;
  }
  body += `</tbody></table>`;

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { fleet, byType, granularity, range } = data;
  const title = 'Utilization';
  const subtitle = `${range.from.slice(0,10)} → ${range.to.slice(0,10)} · ${granularity}`;

  return {
    title,
    subtitle,
    sheets: [
      {
        name: 'Trend',
        bannerRows: [[title], [subtitle]],
        columns: [
          { header: granularity === 'day' ? 'Day' : granularity === 'week' ? 'Week' : 'Month',
            key: 'label', width: 22 },
          { header: 'Days in bucket', key: 'daysInBucket', width: 14, type: 'integer' },
          { header: 'Utilization',    key: 'utilization',  width: 14, type: 'percent' },
        ],
        rows: fleet.buckets.map((b) => ({
          label: b.label, daysInBucket: b.daysInBucket, utilization: b.utilization,
        })),
      },
      {
        name: 'By class',
        bannerRows: [['By vehicle class'], [subtitle]],
        columns: [
          { header: 'Class',       key: 'name',           width: 22 },
          { header: 'Code',        key: 'code',           width: 10 },
          { header: 'Capacity',    key: 'capacity',       width: 10, type: 'integer' },
          { header: 'Rental days', key: 'rentalDays',     width: 14, type: 'integer' },
          { header: 'Utilization', key: 'utilizationPct', width: 14, type: 'percent' },
        ],
        rows: byType.map((t) => ({
          name: t.name, code: t.code || '',
          capacity: t.capacity, rentalDays: t.rentalDays, utilizationPct: t.utilizationPct,
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'utilization',
  title: 'Utilization',
  computeData,
  renderHtml,
  buildExcelSpec,
});

export const _utilizationInternal = {
  computeData,
  buildDailyCounts,
  bucketDailySeries,
  pickGranularity,
  startOfDay, startOfIsoWeek, startOfMonth,
  addDays, addMonths,
  ACTIVE_STATUSES,
  MAX_DAYS,
};
