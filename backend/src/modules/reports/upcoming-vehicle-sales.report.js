/**
 * Upcoming Vehicle Sales — Round 29 (2026-05-23).
 *
 * Vehicles approaching the "time to sell" threshold based on mileage and age.
 * Right-now snapshot — no date range, just thresholds + optional location.
 *
 *   GET /api/reports/upcoming-vehicle-sales?maxMileage=&maxAge=&approachingPct=&locationId=
 *     Returns { asOf, thresholds, totals, buckets[], filters }
 *
 * Default thresholds:
 *   maxMileage     = 60000      (sell when ≥ this)
 *   maxAge         = 4 (years)  (sell when age ≥ this)
 *   approachingPct = 0.10       ("approaching" zone is within this % of either threshold)
 *
 * Buckets (triage order):
 *   OVER         — mileage ≥ maxMileage OR age ≥ maxAge   (sell now)
 *   APPROACHING  — mileage in (maxMileage*(1-pct), maxMileage)
 *                  OR age in (maxAge*(1-pct), maxAge)
 *   SAFE         — well below both (not returned in the list)
 *
 * RETIRED-equivalent vehicles (status=OUT_OF_SERVICE) are still shown so the
 * user can verify they were actually pulled from the fleet.
 */

import { registerReport } from './reports-v2.routes.js';
import {
  DEFAULT_TENANT_TIMEZONE,
  startOfDayInTz,
  dayLabelInTz,
} from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

const DEFAULT_MAX_MILEAGE = 60_000;
const DEFAULT_MAX_AGE = 4;
const DEFAULT_APPROACHING_PCT = 0.10;
const MAX_RESULTS = 500;

const VEHICLE_STATUSES = ['AVAILABLE', 'RESERVED', 'ON_RENT', 'IN_MAINTENANCE', 'OUT_OF_SERVICE'];
const STATUS_LABEL = {
  AVAILABLE:      'Available',
  RESERVED:       'Reserved',
  ON_RENT:        'On rent',
  IN_MAINTENANCE: 'Maintenance',
  OUT_OF_SERVICE: 'Out of service',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

// 2026-05-26: tz-aware helpers — asOfLabel rendered server-local TZ.
function startOfDay(d, tz = DEFAULT_TENANT_TIMEZONE) { return startOfDayInTz(d, tz); }
function dayLabel(d, tz = DEFAULT_TENANT_TIMEZONE) { return dayLabelInTz(d, tz); }
function timeLabel(d, tz = DEFAULT_TENANT_TIMEZONE) {
  const out = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return out.replace(' AM', 'am').replace(' PM', 'pm').replace(' ', '');
}

function ageYears(vehicleYear, asOfYear) {
  if (!vehicleYear || !Number.isFinite(vehicleYear)) return null;
  return asOfYear - vehicleYear;
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
// Pure bucketing — exposed for unit tests
// ---------------------------------------------------------------------------

/**
 * Decide which bucket a vehicle lands in given current mileage + age and the
 * thresholds. Returns 'OVER' | 'APPROACHING' | 'SAFE'.
 *
 * Pure function. Vehicles with null mileage are treated as 0 (not over).
 * Vehicles with null age (missing year) only count by mileage.
 */
function bucketize({ mileage, age, maxMileage, maxAge, approachingPct }) {
  const m = num(mileage);
  const a = age == null ? null : num(age);
  const approachMileage = maxMileage * (1 - approachingPct);
  const approachAge = maxAge * (1 - approachingPct);

  const mileageOver = m >= maxMileage;
  const ageOver = a != null && a >= maxAge;
  if (mileageOver || ageOver) return 'OVER';

  const mileageApproaching = m >= approachMileage && m < maxMileage;
  const ageApproaching = a != null && a >= approachAge && a < maxAge;
  if (mileageApproaching || ageApproaching) return 'APPROACHING';

  return 'SAFE';
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const locationId = (query && query.locationId) || null;
  const maxMileage = Math.max(0, num(query?.maxMileage) || DEFAULT_MAX_MILEAGE);
  const maxAge = Math.max(0, num(query?.maxAge) || DEFAULT_MAX_AGE);
  const approachingPct = (() => {
    const raw = num(query?.approachingPct);
    if (raw <= 0 || raw >= 1) return DEFAULT_APPROACHING_PCT;
    return raw;
  })();

  const asOf = (deps && deps.now) || new Date();
  // Use tenant TZ for the year — at year-end (e.g. PR Dec 31 11pm = UTC
  // Jan 1 3am), getFullYear on the server in UTC would say "next year" and
  // misclassify vehicle age by 1 year for a few hours.
  const asOfYear = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tenantTz, year: 'numeric' }).format(asOf)
  );
  const approachMileage = maxMileage * (1 - approachingPct);
  const approachAge = maxAge * (1 - approachingPct);
  // Earliest model year that still qualifies as "approaching" by age
  const minQualifyingYear = Math.floor(asOfYear - Math.ceil(approachAge));

  const where = {
    tenantId,
    OR: [
      { mileage: { gte: Math.ceil(approachMileage) } },
      // Year may be null; Prisma handles null gracefully via the OR branch.
      { year: { lte: minQualifyingYear } },
    ],
  };
  if (locationId) where.homeLocationId = locationId;

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
    },
    orderBy: [{ mileage: 'desc' }, { year: 'asc' }],
    take: MAX_RESULTS,
  });

  // Bucket + project
  const overRows = [];
  const approachingRows = [];
  for (const v of vehicles) {
    const age = ageYears(v.year, asOfYear);
    const bucket = bucketize({ mileage: num(v.mileage), age, maxMileage, maxAge, approachingPct });
    if (bucket === 'SAFE') continue; // shouldn't happen given the where clause, but guard
    const reasons = [];
    if (num(v.mileage) >= maxMileage) reasons.push(`mileage ≥ ${maxMileage.toLocaleString()}`);
    else if (num(v.mileage) >= approachMileage) reasons.push(`mileage approaching (${num(v.mileage).toLocaleString()})`);
    if (age != null && age >= maxAge) reasons.push(`age ≥ ${maxAge}y`);
    else if (age != null && age >= approachAge) reasons.push(`age approaching (${age}y)`);

    const row = {
      id: v.id,
      internalNumber: v.internalNumber,
      plate: v.plate || null,
      year: v.year || null,
      make: v.make || null,
      model: v.model || null,
      label: [v.year, v.make, v.model].filter(Boolean).join(' ') || null,
      color: v.color || null,
      mileage: num(v.mileage),
      age,
      status: v.status,
      statusLabel: STATUS_LABEL[v.status] || v.status,
      vehicleType: v.vehicleType?.name || null,
      homeLocation: v.homeLocation?.name || null,
      reasons,
    };
    if (bucket === 'OVER') overRows.push(row);
    else approachingRows.push(row);
  }

  const truncated = vehicles.length >= MAX_RESULTS;

  // Average mileage across surfaced candidates (sanity-check signal)
  const totalMileage = vehicles.reduce((acc, v) => acc + num(v.mileage), 0);
  const avgMileage = vehicles.length > 0 ? Math.round(totalMileage / vehicles.length) : 0;

  // Highest-mileage vehicle = top of the OVER list (already sorted desc), or the top of approaching as fallback
  const highest = overRows[0] || approachingRows[0] || null;

  return {
    asOf: asOf.toISOString(),
    asOfLabel: `${dayLabel(asOf, tenantTz)} · ${timeLabel(asOf, tenantTz)}`,
    tenantTimeZone: tenantTz,
    thresholds: { maxMileage, maxAge, approachingPct },
    totals: {
      overCount: overRows.length,
      approachingCount: approachingRows.length,
      candidateCount: overRows.length + approachingRows.length,
      averageMileage: avgMileage,
      highestMileage: highest ? highest.mileage : 0,
    },
    buckets: [
      { key: 'OVER',        label: 'Sell now · over threshold', tone: 'danger',  count: overRows.length,        vehicles: overRows },
      { key: 'APPROACHING', label: 'Approaching threshold',     tone: 'warning', count: approachingRows.length, vehicles: approachingRows },
    ],
    filters: { locationId },
    truncated,
  };
}

// ---------------------------------------------------------------------------
// HTML (PDF)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderHtml(data) {
  const { totals, buckets, thresholds, asOfLabel } = data;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Candidates</div><div class="strip-value">${totals.candidateCount}</div></div>
    <div class="strip-card heat-red"><div class="strip-label">Over threshold</div><div class="strip-value">${totals.overCount}</div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Approaching</div><div class="strip-value">${totals.approachingCount}</div></div>
    <div class="strip-card"><div class="strip-label">Avg mileage</div><div class="strip-value">${totals.averageMileage.toLocaleString()}</div></div>
  </div>`;

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">As of ${escapeHtml(asOfLabel)} · Thresholds: ${thresholds.maxMileage.toLocaleString()} mi · ${thresholds.maxAge}y · approaching = within ${Math.round(thresholds.approachingPct * 100)}%</p>`;

  for (const b of buckets) {
    if (b.count === 0) continue;
    body += `<h3>${escapeHtml(b.label.toUpperCase())} · ${b.count}</h3>
      <table style="font-size:10px"><thead><tr>
        <th style="text-align:left">Plate</th>
        <th style="text-align:left">Vehicle</th>
        <th style="text-align:left">Class</th>
        <th class="num">Mileage</th>
        <th class="num">Age</th>
        <th style="text-align:left">Status</th>
        <th style="text-align:left">Location</th>
        <th style="text-align:left">Reasons</th>
      </tr></thead><tbody>`;
    for (const v of b.vehicles) {
      const label = v.label ? `${v.label}${v.color ? ` · ${v.color}` : ''}` : (v.color || '—');
      body += `<tr>
        <td><strong>${escapeHtml(v.plate || '—')}</strong></td>
        <td>${escapeHtml(label)}</td>
        <td>${escapeHtml(v.vehicleType || '—')}</td>
        <td class="num">${v.mileage.toLocaleString()}</td>
        <td class="num">${v.age == null ? '—' : `${v.age}y`}</td>
        <td>${escapeHtml(v.statusLabel)}</td>
        <td>${escapeHtml(v.homeLocation || '—')}</td>
        <td>${escapeHtml(v.reasons.join('; '))}</td>
      </tr>`;
    }
    body += `</tbody></table>`;
  }

  if (totals.candidateCount === 0) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No vehicles are approaching or over the sale thresholds.</p>`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { buckets, thresholds, asOfLabel } = data;
  const title = 'Upcoming Vehicle Sales';
  const subtitle = `As of ${asOfLabel} · ${thresholds.maxMileage.toLocaleString()} mi · ${thresholds.maxAge}y`;

  const columns = [
    { header: 'Bucket',        key: 'bucket',     width: 22 },
    { header: 'Plate',         key: 'plate',      width: 10 },
    { header: 'Internal #',    key: 'internal',   width: 12 },
    { header: 'Year',          key: 'year',       width: 8,  type: 'integer' },
    { header: 'Make',          key: 'make',       width: 14 },
    { header: 'Model',         key: 'model',      width: 14 },
    { header: 'Color',         key: 'color',      width: 10 },
    { header: 'Class',         key: 'class',      width: 14 },
    { header: 'Mileage',       key: 'mileage',    width: 12, type: 'integer' },
    { header: 'Age',           key: 'age',        width: 8,  type: 'integer' },
    { header: 'Status',        key: 'status',     width: 14 },
    { header: 'Location',      key: 'location',   width: 18 },
    { header: 'Reasons',       key: 'reasons',    width: 40 },
  ];

  const rows = [];
  for (const b of buckets) {
    for (const v of b.vehicles) {
      rows.push({
        bucket: b.label,
        plate: v.plate || '',
        internal: v.internalNumber || '',
        year: v.year || '',
        make: v.make || '',
        model: v.model || '',
        color: v.color || '',
        class: v.vehicleType || '',
        mileage: v.mileage,
        age: v.age == null ? '' : v.age,
        status: v.statusLabel,
        location: v.homeLocation || '',
        reasons: v.reasons.join('; '),
      });
    }
  }

  return {
    title,
    subtitle,
    sheets: [{
      name: 'Candidates',
      bannerRows: [[title], [subtitle]],
      columns,
      rows,
    }],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'upcoming-vehicle-sales',
  title: 'Upcoming Vehicle Sales',
  computeData,
  renderHtml,
  buildExcelSpec,
});

export const _upcomingVehicleSalesInternal = {
  computeData,
  bucketize,
  ageYears,
  DEFAULT_MAX_MILEAGE,
  DEFAULT_MAX_AGE,
  DEFAULT_APPROACHING_PCT,
  VEHICLE_STATUSES,
  STATUS_LABEL,
};
