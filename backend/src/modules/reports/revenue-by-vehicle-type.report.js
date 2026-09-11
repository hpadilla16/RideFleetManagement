/**
 * Revenue by Vehicle Type — 2026-09-11.
 *
 * Hector: "a vehicle type report, where the tenant can see how much a vehicle
 * type is generating in revenue."
 *
 *   GET /api/reports/revenue-by-vehicle-type?from=&to=&locationId=
 *     Returns { range, totals, rows[], unassigned, idleTypes[], filters }
 *
 * ── THE REVENUE DEFINITION IS BORROWED, NOT INVENTED ────────────────────────
 * Every figure here comes through the same door as sales.report.js: selected
 * RentalAgreementCharge rows, dated by RentalAgreement.pickupAt, with
 * CANCELLED and DRAFT agreements excluded (a voided agreement keeps its
 * charges selected, and a DRAFT exists the moment the wizard opens — neither
 * is a sale). TAX is not revenue and DEPOSIT is a hold, so both are excluded
 * from the headline and reported separately. Two reports that disagree about
 * what a dollar is are worse than one report, so if that convention ever
 * changes, change it in both.
 *
 * ── WHICH TYPE GETS THE MONEY ───────────────────────────────────────────────
 * The vehicle actually on the agreement, not the class the customer booked.
 * The tenant is asking what their METAL earned, and a Corolla that went out
 * against an intermediate booking earned its money as a Corolla. Two honest
 * consequences, both surfaced rather than smoothed over:
 *
 *   - An agreement whose vehicle was swapped mid-rental lands entirely on the
 *     final vehicle's type. RentalAgreementVehicleSwap records the history;
 *     splitting a rental's revenue across two types would need a per-day
 *     allocation this report deliberately does not guess at.
 *   - An agreement with no vehicle assigned cannot be attributed at all. Those
 *     are counted into an `unassigned` block and shown, never quietly dropped,
 *     because "revenue that belongs to no type" is a data-entry finding the
 *     tenant wants to see.
 *
 * ── WHY REVENUE PER UNIT IS THE COLUMN THAT MATTERS ─────────────────────────
 * Total revenue per type mostly measures how many of that type you own. A
 * fleet of thirty compacts will out-earn four minivans and tell you nothing.
 * Revenue ÷ units in fleet is the number that says which type to buy more of,
 * so it is computed here and sorted on by default.
 *
 * The attribution rules themselves live in revenue-by-vehicle-type.math.js,
 * so they can be tested without booting express.
 *
 * Informational only — nothing here feeds billing.
 */

import { registerReport } from './reports-v2.routes.js';
import {
  DEFAULT_TENANT_TIMEZONE,
  startOfDayInTz,
  startOfMonthInTz,
  addDaysInTz,
  dayLabelInTz,
} from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

import {
  EXCLUDED_AGREEMENT_STATUSES,
  aggregate,
  aggregateByModel,
  modelKey,
  num,
} from './revenue-by-vehicle-type.math.js';

const MAX_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

async function computeData({ tenantId, from, to, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId)) || DEFAULT_TENANT_TIMEZONE;
  const now = deps.now || new Date();
  const locationId = (query && query.locationId) || null;

  // Narrow to specific metal. `model=XC40` on its own is enough -- nobody
  // types the make when they already know the model -- and both are a
  // case-insensitive contains so "xc40", "XC40" and "XC40 Recharge" all land.
  const makeFilter = (query?.make || '').trim();
  const modelFilter = (query?.model || '').trim();
  const groupByModel = String(query?.groupBy || '').toLowerCase() === 'model';

  const startOfDay = (d) => startOfDayInTz(d, tenantTz);
  const fromDate = from ? startOfDay(from) : startOfMonthInTz(now, tenantTz);
  const toDate = to ? startOfDay(to) : startOfDay(now);
  const numDays = Math.max(1, Math.round((toDate - fromDate) / DAY_MS) + 1);
  const windowEnd = addDaysInTz(fromDate, Math.min(numDays, MAX_DAYS), tenantTz);

  const rentalAgreement = {
    tenantId,
    pickupAt: { gte: fromDate, lt: windowEnd },
    status: { notIn: EXCLUDED_AGREEMENT_STATUSES },
  };
  if (locationId) rentalAgreement.pickupLocationId = locationId;

  // The make/model filter is applied to the VEHICLE on the agreement, which
  // also means an agreement with no vehicle drops out of a filtered run -- as
  // it must: "show me the XC40s" cannot include a rental whose car is unknown.
  const vehicleFilter = {};
  if (makeFilter) vehicleFilter.make = { contains: makeFilter, mode: 'insensitive' };
  if (modelFilter) vehicleFilter.model = { contains: modelFilter, mode: 'insensitive' };
  if (makeFilter || modelFilter) rentalAgreement.vehicle = { is: vehicleFilter };

  const charges = await prisma.rentalAgreementCharge.findMany({
    where: { selected: true, rentalAgreement },
    select: {
      chargeType: true,
      total: true,
      rentalAgreement: {
        select: {
          id: true,
          pickupAt: true,
          returnAt: true,
          vehicle: {
            select: {
              id: true,
              make: true,
              model: true,
              vehicleType: { select: { id: true, code: true, name: true } },
            },
          },
        },
      },
    },
  });

  // Fleet size, so revenue-per-unit means something. SOLD cars are out of the
  // fleet; the branch and make/model filters apply here too, because a
  // denominator counting cars the numerator excluded is worse than no ratio.
  const vehicleWhere = { tenantId, status: { not: 'SOLD' } };
  if (locationId) vehicleWhere.homeLocationId = locationId;
  if (makeFilter) vehicleWhere.make = { contains: makeFilter, mode: 'insensitive' };
  if (modelFilter) vehicleWhere.model = { contains: modelFilter, mode: 'insensitive' };

  let fleetCounts;
  if (groupByModel) {
    // Counted per make+model+type, keyed exactly as aggregateByModel keys its
    // rows, so the two halves cannot drift apart.
    const cars = await prisma.vehicle.findMany({
      where: vehicleWhere,
      select: { make: true, model: true, vehicleType: { select: { code: true } } },
    });
    fleetCounts = new Map();
    for (const v of cars) {
      const k = modelKey(v);
      fleetCounts.set(k, (fleetCounts.get(k) || 0) + 1);
    }
  } else {
    const fleet = await prisma.vehicle.groupBy({
      by: ['vehicleTypeId'],
      where: vehicleWhere,
      _count: { _all: true },
    });
    fleetCounts = new Map(fleet.map((f) => [f.vehicleTypeId, f._count._all]));
  }

  if (groupByModel) {
    const byModel = aggregateByModel(charges, fleetCounts);
    return {
      range: {
        from: fromDate.toISOString(),
        to: addDaysInTz(windowEnd, -1, tenantTz).toISOString(),
        label: `${dayLabelInTz(fromDate, tenantTz)} – ${dayLabelInTz(addDaysInTz(windowEnd, -1, tenantTz), tenantTz)}`,
      },
      groupBy: 'model',
      totals: byModel.totals,
      rows: byModel.rows,
      unassigned: null,
      idleTypes: [],
      filters: { locationId, make: makeFilter || null, model: modelFilter || null, timezone: tenantTz },
    };
  }

  const agg = aggregate(charges, fleetCounts);

  // A type you own but that earned nothing in the window is a finding, not an
  // absence — it is the other half of the question "what is each type doing
  // for me", and it never appears in a table built from revenue rows alone.
  const earning = new Set(agg.rows.map((r) => r.typeId));
  const idleTypeIds = [...fleetCounts.keys()].filter((id) => id && !earning.has(id));
  let idleTypes = [];
  if (idleTypeIds.length) {
    const names = await prisma.vehicleType.findMany({
      where: { id: { in: idleTypeIds } },
      select: { id: true, code: true, name: true },
    });
    idleTypes = names.map((t) => ({ ...t, units: num(fleetCounts.get(t.id)) }))
      .sort((a, b) => b.units - a.units);
  }

  return {
    range: {
      from: fromDate.toISOString(),
      to: addDaysInTz(windowEnd, -1, tenantTz).toISOString(),
      label: `${dayLabelInTz(fromDate, tenantTz)} – ${dayLabelInTz(addDaysInTz(windowEnd, -1, tenantTz), tenantTz)}`,
    },
    totals: agg.totals,
    rows: agg.rows,
    unassigned: agg.unassigned,
    idleTypes,
    groupBy: 'type',
    filters: { locationId, make: makeFilter || null, model: modelFilter || null, timezone: tenantTz },
  };
}

// ---------------------------------------------------------------------------
// HTML (PDF) rendering
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const dollars = (v) => (v == null ? '—' : `$${num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function renderHtml(data) {
  const rows = data?.rows || [];
  const t = data?.totals || {};

  const body = rows.map((r) => `
    <tr>
      <td>${esc(r.code || '')}</td>
      <td>${esc(r.name)}</td>
      <td class="num">${dollars(r.revenue)}</td>
      <td class="num">${r.sharePct == null ? '—' : `${r.sharePct}%`}</td>
      <td class="num">${r.rentals}</td>
      <td class="num">${r.days}</td>
      <td class="num">${dollars(r.avgPerRental)}</td>
      <td class="num">${dollars(r.revenuePerDay)}</td>
      <td class="num">${r.units || '—'}</td>
      <td class="num"><strong>${dollars(r.revenuePerUnit)}</strong></td>
    </tr>`).join('');

  let html = `
    <p class="muted">Revenue excludes tax (${dollars(t.taxAmount)}) and security deposits
    (${dollars(t.depositAmount)}), and counts only agreements that reached the counter.
    Each rental is attributed to the vehicle actually assigned to it.</p>
    <table>
      <thead><tr>
        <th>Code</th><th>Vehicle type</th><th class="num">Revenue</th><th class="num">Share</th>
        <th class="num">Rentals</th><th class="num">Days</th><th class="num">Avg / rental</th>
        <th class="num">Per day</th><th class="num">Units</th><th class="num">Per unit</th>
      </tr></thead>
      <tbody>${body || '<tr><td colspan="10">No revenue in this range.</td></tr>'}</tbody>
      <tfoot><tr>
        <th colspan="2">Total</th>
        <th class="num">${dollars(t.revenue)}</th><th></th>
        <th class="num">${t.rentals || 0}</th><th class="num">${t.days || 0}</th>
        <th colspan="4"></th>
      </tr></tfoot>
    </table>`;

  if (data?.unassigned && data.unassigned.revenue) {
    html += `<h3>Not attributable to a type</h3>
      <p>${dollars(data.unassigned.revenue)} across ${data.unassigned.rentals} rental(s) with no
      vehicle on the agreement. These are excluded from every per-type figure above.</p>`;
  }

  if (data?.idleTypes?.length) {
    html += `<h3>Types in the fleet with no revenue this range</h3>
      <table><thead><tr><th>Code</th><th>Vehicle type</th><th class="num">Units</th></tr></thead><tbody>${
      data.idleTypes.map((x) => `<tr><td>${esc(x.code || '')}</td><td>${esc(x.name)}</td><td class="num">${x.units}</td></tr>`).join('')
    }</tbody></table>`;
  }

  return html;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const title = 'Revenue by Vehicle Type';
  const subtitle = data?.range?.label || '';
  const t = data?.totals || {};

  const columns = [
    { header: 'Code',          key: 'code',    width: 12 },
    { header: 'Vehicle type',  key: 'name',    width: 28 },
    { header: 'Revenue',       key: 'revenue', width: 16, type: 'currency' },
    { header: 'Share %',       key: 'share',   width: 10 },
    { header: 'Rentals',       key: 'rentals', width: 10, type: 'integer' },
    { header: 'Rental days',   key: 'days',    width: 12, type: 'integer' },
    { header: 'Avg / rental',  key: 'avg',     width: 14, type: 'currency' },
    { header: 'Revenue / day', key: 'perDay',  width: 14, type: 'currency' },
    { header: 'Units in fleet', key: 'units',  width: 12, type: 'integer' },
    { header: 'Revenue / unit', key: 'perUnit', width: 16, type: 'currency' },
  ];

  const rows = (data?.rows || []).map((r) => ({
    code: r.code || '',
    name: r.name,
    revenue: r.revenue,
    share: r.sharePct ?? '',
    rentals: r.rentals,
    days: r.days,
    avg: r.avgPerRental ?? '',
    perDay: r.revenuePerDay ?? '',
    units: r.units || '',
    perUnit: r.revenuePerUnit ?? '',
  }));

  if (data?.unassigned && data.unassigned.revenue) {
    rows.push({
      code: '', name: 'Unassigned (no vehicle on the agreement)',
      revenue: data.unassigned.revenue, share: data.unassigned.sharePct ?? '',
      rentals: data.unassigned.rentals, days: data.unassigned.days,
      avg: data.unassigned.avgPerRental ?? '', perDay: data.unassigned.revenuePerDay ?? '',
      units: '', perUnit: '',
    });
  }

  const sheets = [{
    name: 'Revenue by type',
    bannerRows: [
      [title],
      [subtitle],
      [`Excludes tax ${dollars(t.taxAmount)} and deposits ${dollars(t.depositAmount)}`],
    ],
    columns,
    rows,
  }];

  if (data?.idleTypes?.length) {
    sheets.push({
      name: 'No revenue',
      bannerRows: [['Types in the fleet with no revenue this range'], [subtitle]],
      columns: [
        { header: 'Code', key: 'code', width: 12 },
        { header: 'Vehicle type', key: 'name', width: 28 },
        { header: 'Units in fleet', key: 'units', width: 14, type: 'integer' },
      ],
      rows: data.idleTypes.map((x) => ({ code: x.code || '', name: x.name, units: x.units })),
    });
  }

  return { title, subtitle, sheets };
}

registerReport({
  slug: 'revenue-by-vehicle-type',
  title: 'Revenue by Vehicle Type',
  computeData,
  renderHtml,
  buildExcelSpec,
});

export const _revenueByVehicleTypeInternal = { computeData };
