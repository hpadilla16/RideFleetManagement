/**
 * Commission — Round 31 (2026-05-23).
 *
 * Commission paid (or accrued) per period, grouped by employee. Simpler
 * sibling of commission-sales-performance — that report is per-clerk attach %
 * by service; this one is dollars-out-the-door from the AgreementCommission
 * ledger.
 *
 *   GET /api/reports/commission?from=&to=&locationId=&status=
 *     Returns { range, totals, byEmployee[], byDay[], filters }
 *
 *   GET /api/reports/commission/employee?employeeUserId=&from=&to=&locationId=&status=
 *     Drill-down: individual AgreementCommission rows for one employee.
 *
 * Date axis: AgreementCommission.calculatedAt (when commission was earned).
 * Status filter: ALL (default, excludes VOID) | PAID | APPROVED | PENDING.
 * Location filter: narrows via rentalAgreement.pickupLocationId.
 *
 * Default range: 1st of current month → today.
 */

import { registerReport } from './reports-v2.routes.js';
import {
  DEFAULT_TENANT_TIMEZONE,
  startOfDayInTz,
  startOfMonthInTz,
  addDaysInTz,
  isoDayInTz,
  dayLabelInTz,
} from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 365;
const STATUSES = ['PAID', 'APPROVED', 'PENDING', 'VOID'];
const NON_VOID_STATUSES = STATUSES.filter((s) => s !== 'VOID');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function moneyRound(n) { return Math.round(n * 100) / 100; }

// 2026-05-26: TZ-aware date helpers (see sales.report.js for the rationale).
function startOfDay(d)   { return startOfDayInTz(d, DEFAULT_TENANT_TIMEZONE); }
function startOfMonth(d) { return startOfMonthInTz(d, DEFAULT_TENANT_TIMEZONE); }
function addDays(d, n)   { return addDaysInTz(d, n); }
function isoDay(d)       { return isoDayInTz(d, DEFAULT_TENANT_TIMEZONE); }
function dayLabel(d)     { return dayLabelInTz(d, DEFAULT_TENANT_TIMEZONE); }

function daysBetween(from, to) {
  return Math.max(1, Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS) + 1);
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

function statusFilterToWhere(status) {
  // Default = exclude VOID
  if (!status || status === 'ALL') return { in: NON_VOID_STATUSES };
  if (STATUSES.includes(status)) return { equals: status };
  return { in: NON_VOID_STATUSES };
}

function buildCommissionWhere({ tenantId, locationId, status, gte, lt }) {
  // 2026-05-26: Bucket by **CHECKOUT inspection date** (when commission was
  // earned), not by AgreementCommission.calculatedAt (which is whatever
  // wall-clock the sync last ran). The rentalAgreement.inspections.some
  // predicate scopes commissions to those whose checkout happened in the
  // window — matches the filter used by commission-sales-performance.
  const where = {
    tenantId,
    status: statusFilterToWhere(status),
    rentalAgreement: {
      inspections: {
        some: {
          phase: 'CHECKOUT',
          capturedAt: { gte, lt },
          actorUserId: { not: null },
        },
      },
      ...(locationId ? { pickupLocationId: locationId } : {}),
    },
  };
  return where;
}

// ---------------------------------------------------------------------------
// Pure aggregation — exposed for unit tests
// ---------------------------------------------------------------------------

/**
 * Group commission rows by employeeUserId and also by day. Returns
 * { byEmployee, byDay, totals } where rows preserve status-bucketed amounts
 * so the UI can show "paid · approved · pending" splits inline.
 */
// `tz` (2nd arg) defaults to PR for the unit tests; production paths
// (computeData) override with the resolved tenant timezone.
function aggregate(commissionRows, tz = DEFAULT_TENANT_TIMEZONE) {
  const byEmployee = new Map();
  const byDay = new Map();
  const totals = {
    amount: 0,
    paidAmount: 0,
    approvedAmount: 0,
    pendingAmount: 0,
    count: 0,
    rentalIds: new Set(),
  };

  for (const c of commissionRows) {
    const amt = num(c.commissionAmount);
    totals.amount = moneyRound(totals.amount + amt);
    totals.count += 1;
    if (c.rentalAgreementId) totals.rentalIds.add(c.rentalAgreementId);
    if (c.status === 'PAID')     totals.paidAmount     = moneyRound(totals.paidAmount + amt);
    if (c.status === 'APPROVED') totals.approvedAmount = moneyRound(totals.approvedAmount + amt);
    if (c.status === 'PENDING')  totals.pendingAmount  = moneyRound(totals.pendingAmount + amt);

    // By employee
    const eid = c.employeeUserId || '(unknown)';
    if (!byEmployee.has(eid)) {
      byEmployee.set(eid, {
        employeeUserId: eid,
        employeeName: c.employeeUser?.fullName || null,
        employeeEmail: c.employeeUser?.email || null,
        amount: 0,
        count: 0,
        paidAmount: 0,
        approvedAmount: 0,
        pendingAmount: 0,
        rentalIds: new Set(),
      });
    }
    const e = byEmployee.get(eid);
    e.amount = moneyRound(e.amount + amt);
    e.count += 1;
    if (c.rentalAgreementId) e.rentalIds.add(c.rentalAgreementId);
    if (c.status === 'PAID')     e.paidAmount     = moneyRound(e.paidAmount + amt);
    if (c.status === 'APPROVED') e.approvedAmount = moneyRound(e.approvedAmount + amt);
    if (c.status === 'PENDING')  e.pendingAmount  = moneyRound(e.pendingAmount + amt);

    // By day — bucket by CHECKOUT date (when commission was earned). Falls
    // back to calculatedAt for very old rows (pre-2026-05-26 backfill).
    const bucketDate = c.checkoutAt || c.calculatedAt;
    if (bucketDate) {
      const dKey = isoDayInTz(startOfDayInTz(new Date(bucketDate), tz), tz);
      if (!byDay.has(dKey)) byDay.set(dKey, { iso: dKey, amount: 0, count: 0 });
      const d = byDay.get(dKey);
      d.amount = moneyRound(d.amount + amt);
      d.count += 1;
    }
  }

  // Finalize: convert rental sets to counts, sort employees by total desc
  const employees = Array.from(byEmployee.values())
    .map((e) => ({
      employeeUserId: e.employeeUserId,
      employeeName: e.employeeName,
      employeeEmail: e.employeeEmail,
      amount: e.amount,
      count: e.count,
      rentalCount: e.rentalIds.size,
      averagePerRental: e.rentalIds.size > 0 ? moneyRound(e.amount / e.rentalIds.size) : 0,
      paidAmount: e.paidAmount,
      approvedAmount: e.approvedAmount,
      pendingAmount: e.pendingAmount,
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    byEmployee: employees,
    byDay: Array.from(byDay.values()).sort((a, b) => a.iso.localeCompare(b.iso)),
    totals: {
      amount: totals.amount,
      paidAmount: totals.paidAmount,
      approvedAmount: totals.approvedAmount,
      pendingAmount: totals.pendingAmount,
      count: totals.count,
      employeeCount: employees.length,
      rentalCount: totals.rentalIds.size,
      averagePerRental: totals.rentalIds.size > 0 ? moneyRound(totals.amount / totals.rentalIds.size) : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, from, to, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  // Resolve tenant TZ + shadow date helpers.
  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const startOfDay   = (d)    => startOfDayInTz(d, tenantTz);
  const startOfMonth = (d)    => startOfMonthInTz(d, tenantTz);
  const addDays      = (d, n) => addDaysInTz(d, n);
  const isoDay       = (d)    => isoDayInTz(d, tenantTz);
  const dayLabel     = (d)    => dayLabelInTz(d, tenantTz);

  const locationId = (query && query.locationId) || null;
  const status = query?.status || 'ALL';

  const now = (deps && deps.now) || new Date();
  const fromDate = from ? startOfDay(from) : startOfMonth(now);
  const toDate   = to   ? startOfDay(to)   : startOfDay(now);
  const numDays = Math.max(1, Math.round((toDate - fromDate) / DAY_MS) + 1);
  const safeNumDays = Math.min(numDays, MAX_DAYS);
  const windowEnd = addDays(fromDate, safeNumDays);
  const truncated = numDays > MAX_DAYS;

  const rows = await prisma.agreementCommission.findMany({
    where: buildCommissionWhere({
      tenantId, locationId, status, gte: fromDate, lt: windowEnd,
    }),
    select: {
      id: true,
      employeeUserId: true,
      rentalAgreementId: true,
      status: true,
      commissionAmount: true,
      calculatedAt: true,
      employeeUser: { select: { fullName: true, email: true } },
      // Pull the CHECKOUT inspection for this agreement so we bucket the
      // day-chart by checkout date (not by snapshot calculatedAt, which is
      // wall-clock-when-sync-ran and collapses to a single day after a
      // backfill).
      rentalAgreement: {
        select: {
          inspections: {
            where: { phase: 'CHECKOUT', actorUserId: { not: null } },
            orderBy: [{ capturedAt: 'desc' }, { updatedAt: 'desc' }],
            take: 1,
            select: { capturedAt: true },
          },
        },
      },
    },
  });

  // Hoist checkoutAt up onto each row so aggregate() can read it without
  // navigating into rentalAgreement.inspections.
  const rowsWithCheckout = rows.map((r) => ({
    ...r,
    checkoutAt: r.rentalAgreement?.inspections?.[0]?.capturedAt || null,
  }));

  const agg = aggregate(rowsWithCheckout, tenantTz);

  // LAX #5 (2026-07-25): monthly VALIDATED review counts per employee — the
  // number that drives the review-tier percent. Summed across the months the
  // window touches; fail-soft (a ReviewProof hiccup must not kill payouts).
  const monthKeys = [];
  {
    const cursor = new Date(fromDate);
    cursor.setDate(1);
    while (cursor < windowEnd) {
      monthKeys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }
  // Optional-chained: the unit tests inject a minimal prisma mock without
  // the ReviewProof delegate, and a missing delegate must read as "0
  // reviews", not a crash.
  const reviewCounts = monthKeys.length && prisma.reviewProof?.groupBy
    ? await prisma.reviewProof.groupBy({
        by: ['employeeUserId'],
        where: { tenantId, monthKey: { in: monthKeys }, status: 'VALIDATED' },
        _count: { _all: true }
      }).catch(() => [])
    : [];
  const reviewsByEmployee = new Map(reviewCounts.map((r) => [r.employeeUserId, r._count._all]));
  const byEmployeeWithReviews = agg.byEmployee.map((e) => ({
    ...e,
    reviewsValidated: reviewsByEmployee.get(e.employeeUserId) || 0
  }));

  // Build a day skeleton so the chart shows zeros for empty days
  const days = [];
  for (let i = 0; i < safeNumDays; i++) {
    const d = addDays(fromDate, i);
    const iso = isoDay(d);
    const existing = agg.byDay.find((b) => b.iso === iso);
    days.push({
      iso,
      label: dayLabel(d),
      amount: existing ? existing.amount : 0,
      count: existing ? existing.count : 0,
    });
  }

  // Peak day
  let peakDay = null;
  for (const d of days) {
    if (!peakDay || d.amount > peakDay.amount) peakDay = d;
  }

  return {
    range: { from: fromDate.toISOString(), to: addDays(windowEnd, -1).toISOString() },
    rangeDays: safeNumDays,
    truncated,
    totals: agg.totals,
    byEmployee: byEmployeeWithReviews,
    byDay: days,
    peakDay: peakDay && peakDay.amount > 0 ? peakDay : null,
    tenantTimeZone: tenantTz,
    filters: { locationId, status: status === 'ALL' ? null : status },
  };
}

// ---------------------------------------------------------------------------
// Drill-down — commission rows for one employee
// ---------------------------------------------------------------------------

async function employeeDrillDownHandler(req, res, { tenantId }) {
  const prisma = await resolveDefaultPrisma();
  const employeeUserId = req.query?.employeeUserId ? String(req.query.employeeUserId) : null;
  const locationId = req.query?.locationId ? String(req.query.locationId) : null;
  const status = req.query?.status || 'ALL';
  // Pass the RAW query strings to the tz-aware helpers with the TENANT's tz —
  // exactly like computeData. The old `new Date(raw)` wrap parsed '2026-07-01'
  // as UTC midnight (= Jun 30 in PR) and the module-level helpers were pinned
  // to PR, so the drill-down window ran one day early and never matched the
  // employee's row in the main report (audit 2026-07-13).
  const fromRaw = req.query?.from ? String(req.query.from) : null;
  const toRaw   = req.query?.to   ? String(req.query.to)   : null;

  if (!employeeUserId) return res.status(400).json({ error: 'employeeUserId query param required' });
  if (fromRaw && Number.isNaN(new Date(fromRaw).getTime())) return res.status(400).json({ error: 'invalid from' });
  if (toRaw && Number.isNaN(new Date(toRaw).getTime()))     return res.status(400).json({ error: 'invalid to' });

  const tenantTz = await resolveTenantTimeZone(tenantId);
  const now = new Date();
  const fromDate = fromRaw ? startOfDayInTz(fromRaw, tenantTz) : startOfMonthInTz(now, tenantTz);
  const toDate   = toRaw   ? startOfDayInTz(toRaw, tenantTz)   : startOfDayInTz(now, tenantTz);
  const windowEnd = addDaysInTz(toDate, 1);

  // Same checkout-date filter as the main list. Bucket by when the car was
  // released, not when the snapshot was calculated.
  const where = {
    tenantId,
    employeeUserId,
    status: statusFilterToWhere(status),
    rentalAgreement: {
      inspections: {
        some: {
          phase: 'CHECKOUT',
          capturedAt: { gte: fromDate, lt: windowEnd },
          actorUserId: { not: null },
        },
      },
      ...(locationId ? { pickupLocationId: locationId } : {}),
    },
  };

  const rows = await prisma.agreementCommission.findMany({
    where,
    select: {
      id: true,
      status: true,
      commissionAmount: true,
      grossRevenue: true,
      serviceRevenue: true,
      eligibleRevenue: true,
      calculatedAt: true,
      paidAt: true,
      approvedAt: true,
      monthKey: true,
      rentalAgreement: {
        select: {
          id: true,
          agreementNumber: true,
          customerFirstName: true,
          customerLastName: true,
          pickupAt: true,
          pickupLocation: { select: { name: true } },
        },
      },
    },
    orderBy: { calculatedAt: 'desc' },
    take: 500,
  });

  const totalAmount = moneyRound(rows.reduce((acc, r) => acc + num(r.commissionAmount), 0));

  return res.json({
    employeeUserId,
    locationId,
    totalAmount,
    commissionCount: rows.length,
    commissions: rows.map((r) => ({
      id: r.id,
      status: r.status,
      commissionAmount: num(r.commissionAmount),
      grossRevenue: num(r.grossRevenue),
      serviceRevenue: num(r.serviceRevenue),
      eligibleRevenue: num(r.eligibleRevenue),
      calculatedAt: r.calculatedAt,
      calculatedLabel: r.calculatedAt ? dayLabel(new Date(r.calculatedAt)) : null,
      paidAt: r.paidAt,
      approvedAt: r.approvedAt,
      monthKey: r.monthKey,
      agreementId: r.rentalAgreement?.id || null,
      agreementNumber: r.rentalAgreement?.agreementNumber || null,
      customerName: r.rentalAgreement
        ? `${r.rentalAgreement.customerFirstName || ''} ${r.rentalAgreement.customerLastName || ''}`.trim() || null
        : null,
      pickupAt: r.rentalAgreement?.pickupAt || null,
      pickupLocation: r.rentalAgreement?.pickupLocation?.name || null,
    })),
  });
}

// ---------------------------------------------------------------------------
// HTML (PDF)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function money(n) { return `$${num(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

function renderHtml(data) {
  const { totals, byEmployee, range, filters } = data;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Commission total</div><div class="strip-value">${money(totals.amount)}</div><div style="font-size:9px;color:#5F5E5A">${totals.count} commission line${totals.count === 1 ? '' : 's'}</div></div>
    <div class="strip-card heat-green"><div class="strip-label">Paid</div><div class="strip-value">${money(totals.paidAmount)}</div></div>
    <div class="strip-card"><div class="strip-label">Approved</div><div class="strip-value">${money(totals.approvedAmount)}</div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Pending</div><div class="strip-value">${money(totals.pendingAmount)}</div></div>
  </div>`;

  const filterNote = filters.status ? ` · filtered to ${escapeHtml(filters.status)}` : '';

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">${escapeHtml(range.from.slice(0,10))} → ${escapeHtml(range.to.slice(0,10))}${filterNote}</p>
    <h3>By employee</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Employee</th>
      <th class="num">Commissions</th>
      <th class="num">Rentals</th>
      <th class="num">Avg / rental</th>
      <th class="num">Paid</th>
      <th class="num">Approved</th>
      <th class="num">Pending</th>
      <th class="num">Total</th>
    </tr></thead><tbody>`;
  for (const e of byEmployee) {
    body += `<tr>
      <td><strong>${escapeHtml(e.employeeName || e.employeeUserId)}</strong>${e.employeeEmail ? `<br><span style="font-size:8px;color:#5F5E5A">${escapeHtml(e.employeeEmail)}</span>` : ''}</td>
      <td class="num">${e.count}</td>
      <td class="num">${e.rentalCount}</td>
      <td class="num">${money(e.averagePerRental)}</td>
      <td class="num">${money(e.paidAmount)}</td>
      <td class="num">${money(e.approvedAmount)}</td>
      <td class="num">${money(e.pendingAmount)}</td>
      <td class="num"><strong>${money(e.amount)}</strong></td>
    </tr>`;
  }
  body += `<tr style="background:#f1efe8">
    <td><strong>TOTAL</strong></td>
    <td class="num"><strong>${totals.count}</strong></td>
    <td class="num"><strong>${totals.rentalCount}</strong></td>
    <td class="num">${money(totals.averagePerRental)}</td>
    <td class="num"><strong>${money(totals.paidAmount)}</strong></td>
    <td class="num"><strong>${money(totals.approvedAmount)}</strong></td>
    <td class="num"><strong>${money(totals.pendingAmount)}</strong></td>
    <td class="num"><strong>${money(totals.amount)}</strong></td>
  </tr></tbody></table>`;

  if (byEmployee.length === 0) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No commissions in this window.</p>`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { byEmployee, totals, range } = data;
  const title = 'Commission';
  const subtitle = `${range.from.slice(0,10)} → ${range.to.slice(0,10)}`;

  return {
    title,
    subtitle,
    sheets: [{
      name: 'By employee',
      bannerRows: [[title], [subtitle]],
      columns: [
        { header: 'Employee',         key: 'name',             width: 24 },
        { header: 'Email',            key: 'email',            width: 28 },
        { header: 'Commissions',      key: 'count',            width: 12, type: 'integer'  },
        { header: 'Rentals',          key: 'rentalCount',      width: 10, type: 'integer'  },
        { header: 'Avg / rental',     key: 'averagePerRental', width: 12, type: 'currency' },
        { header: 'Paid',             key: 'paidAmount',       width: 12, type: 'currency' },
        { header: 'Approved',         key: 'approvedAmount',   width: 12, type: 'currency' },
        { header: 'Pending',          key: 'pendingAmount',    width: 12, type: 'currency' },
        { header: 'Total',            key: 'amount',           width: 12, type: 'currency' },
      ],
      rows: byEmployee.map((e) => ({
        name: e.employeeName || e.employeeUserId,
        email: e.employeeEmail || '',
        count: e.count,
        rentalCount: e.rentalCount,
        averagePerRental: e.averagePerRental,
        paidAmount: e.paidAmount,
        approvedAmount: e.approvedAmount,
        pendingAmount: e.pendingAmount,
        amount: e.amount,
      })),
      footerRow: {
        name: 'TOTAL',
        email: '',
        count: totals.count,
        rentalCount: totals.rentalCount,
        averagePerRental: totals.averagePerRental,
        paidAmount: totals.paidAmount,
        approvedAmount: totals.approvedAmount,
        pendingAmount: totals.pendingAmount,
        amount: totals.amount,
      },
    }],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'commission',
  title: 'Commission',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/employee', method: 'get', handler: employeeDrillDownHandler },
  ],
});

export const _commissionInternal = {
  computeData,
  aggregate,
  employeeDrillDownHandler,
  statusFilterToWhere,
  STATUSES,
  NON_VOID_STATUSES,
};
