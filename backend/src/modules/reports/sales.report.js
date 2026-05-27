/**
 * Sales by Category — Round 28 (2026-05-23).
 *
 * Revenue broken out by line-item name. Source: RentalAgreementCharge filtered
 * to selected=true and joined to the parent agreement so we can date-filter
 * by pickupAt (when the rental actually started) and apply the location filter.
 *
 *   GET /api/reports/sales?from=&to=&locationId=&topN=
 *     Returns { range, totals, topCategories[], taxBreakdown[], peakDay,
 *               categoryCount, filters, truncated }
 *
 *   GET /api/reports/sales/category?names=<csv>&from=&to=&locationId=
 *     Drill-down: individual selected charges whose name is in the csv list.
 *
 * Conventions:
 *   - Tax (chargeType=TAX) is SEPARATED from sales — never folded in.
 *     headline figure is gross merchandise sales (pre-tax); tax has its own
 *     breakdown section below.
 *   - Top-N is configurable via query param `topN` (default 10). Everything
 *     past the Nth category gets rolled into a single "Other" bucket whose
 *     `hiddenCategories` array carries the original names so the UI can
 *     pass them to the drill-down endpoint.
 *   - Date axis is RentalAgreement.pickupAt (sales recognized when rental
 *     started). Same convention as payments-by-day.
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

const TAX_CHARGE_TYPE = 'TAX';
// Security deposits are HOLDS, not revenue — they get released or applied to
// damages, never recognized as a sale. Excluded from the sales total just
// like TAX is, and shown as a separate deposit-held breakdown.
const DEPOSIT_CHARGE_TYPE = 'DEPOSIT';
const DEFAULT_TOP_N = 10;
const MAX_TOP_N = 25;
const MAX_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
//
// 2026-05-26: helpers were server-local (setHours / toISOString().slice /
// getMonth) so they bucketed AST-late-night events into the next UTC day.
// Delegated to the tz-aware versions in lib/date-utils.js, pinned to
// DEFAULT_TENANT_TIMEZONE since the legacy export shape (used by tests via
// `_salesInternal`) doesn't take a tz argument.
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function moneyRound(n) { return Math.round(n * 100) / 100; }

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

function buildChargeWhere({ tenantId, locationId, gte, lt }) {
  const rentalAgreement = { tenantId };
  if (locationId) rentalAgreement.pickupLocationId = locationId;
  rentalAgreement.pickupAt = { gte, lt };
  return {
    selected: true,
    rentalAgreement,
  };
}

// ---------------------------------------------------------------------------
// Pure aggregation — exposed for unit testing without prisma
// ---------------------------------------------------------------------------

/**
 * Given a flat list of selected charges with { name, chargeType, total }
 * (and optional rentalAgreement.pickupAt for peak-day), return the
 * Top-N + Other rollup, tax breakdown, and peak day.
 */
// `tz` (3rd arg) defaults to PR so the pure-aggregation test cases keep
// passing without piping a tenant lookup through them. Production callers
// (computeData) override it with the resolved tenant timezone so the
// peak-day bucketing matches the rest of the report.
function aggregate(charges, topN = DEFAULT_TOP_N, tz = DEFAULT_TENANT_TIMEZONE) {
  const salesCharges = [];
  const taxCharges = [];
  const depositCharges = [];
  for (const c of charges) {
    if (c.chargeType === TAX_CHARGE_TYPE) taxCharges.push(c);
    else if (c.chargeType === DEPOSIT_CHARGE_TYPE) depositCharges.push(c);
    else salesCharges.push(c);
  }

  // Group sales by name
  const byName = new Map();
  for (const c of salesCharges) {
    const key = (c.name || '(uncategorized)').trim() || '(uncategorized)';
    if (!byName.has(key)) byName.set(key, { name: key, chargeType: c.chargeType || null, amount: 0, count: 0 });
    const entry = byName.get(key);
    entry.amount = moneyRound(entry.amount + num(c.total));
    entry.count += 1;
  }
  const sortedSales = Array.from(byName.values()).sort((a, b) => b.amount - a.amount);

  const salesAmount = moneyRound(sortedSales.reduce((a, c) => a + c.amount, 0));
  const salesChargeCount = sortedSales.reduce((a, c) => a + c.count, 0);

  // Build topCategories[] with Top-N + Other rollup
  const topCategories = [];
  if (sortedSales.length <= topN) {
    for (const c of sortedSales) {
      topCategories.push(finalizeCategory(c, salesAmount, false));
    }
  } else {
    for (let i = 0; i < topN; i++) {
      topCategories.push(finalizeCategory(sortedSales[i], salesAmount, false));
    }
    const others = sortedSales.slice(topN);
    const otherAmount = moneyRound(others.reduce((a, c) => a + c.amount, 0));
    const otherCount = others.reduce((a, c) => a + c.count, 0);
    topCategories.push({
      name: `Other (${others.length} categor${others.length === 1 ? 'y' : 'ies'})`,
      chargeType: null,
      amount: otherAmount,
      count: otherCount,
      avgPerSale: otherCount > 0 ? moneyRound(otherAmount / otherCount) : 0,
      pctOfSales: salesAmount > 0 ? otherAmount / salesAmount : 0,
      isOther: true,
      hiddenCategories: others.map((o) => o.name),
    });
  }

  // Tax breakdown — group by name within TAX type
  const taxByName = new Map();
  for (const c of taxCharges) {
    const key = (c.name || 'Tax').trim() || 'Tax';
    if (!taxByName.has(key)) taxByName.set(key, { name: key, amount: 0, count: 0 });
    const entry = taxByName.get(key);
    entry.amount = moneyRound(entry.amount + num(c.total));
    entry.count += 1;
  }
  const taxBreakdown = Array.from(taxByName.values()).sort((a, b) => b.amount - a.amount);
  const taxAmount = moneyRound(taxBreakdown.reduce((a, t) => a + t.amount, 0));

  // Deposit breakdown — same shape as tax, separate from sales since these
  // are holds (refunded on return). Useful as a side-by-side display.
  const depositByName = new Map();
  for (const c of depositCharges) {
    const key = (c.name || 'Deposit').trim() || 'Deposit';
    if (!depositByName.has(key)) depositByName.set(key, { name: key, amount: 0, count: 0 });
    const entry = depositByName.get(key);
    entry.amount = moneyRound(entry.amount + num(c.total));
    entry.count += 1;
  }
  const depositBreakdown = Array.from(depositByName.values()).sort((a, b) => b.amount - a.amount);
  const depositAmount = moneyRound(depositBreakdown.reduce((a, d) => a + d.amount, 0));

  // Peak day — by sales (pre-tax) amount
  const dayAmounts = new Map();
  for (const c of salesCharges) {
    if (!c.rentalAgreement?.pickupAt) continue;
    const day = startOfDayInTz(new Date(c.rentalAgreement.pickupAt), tz);
    const iso = isoDayInTz(day, tz);
    if (!dayAmounts.has(iso)) dayAmounts.set(iso, { iso, label: dayLabelInTz(day, tz), amount: 0 });
    const entry = dayAmounts.get(iso);
    entry.amount = moneyRound(entry.amount + num(c.total));
  }
  let peakDay = { iso: null, label: '—', amount: 0 };
  for (const entry of dayAmounts.values()) {
    if (entry.amount > peakDay.amount) peakDay = entry;
  }

  return {
    topCategories,
    taxBreakdown,
    depositBreakdown,
    peakDay,
    salesAmount,
    salesChargeCount,
    taxAmount,
    taxChargeCount: taxCharges.length,
    depositAmount,
    depositChargeCount: depositCharges.length,
    distinctCategoryCount: sortedSales.length,
  };
}

function finalizeCategory(c, salesAmount, isOther) {
  return {
    name: c.name,
    chargeType: c.chargeType,
    amount: c.amount,
    count: c.count,
    avgPerSale: c.count > 0 ? moneyRound(c.amount / c.count) : 0,
    pctOfSales: salesAmount > 0 ? c.amount / salesAmount : 0,
    isOther,
  };
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, from, to, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  // Resolve tenant TZ once, then shadow the file-level startOfDay etc with
  // tenant-aware versions. The original wrappers (pinned to PR) remain in
  // place for tests that destructure them from _salesInternal, but every
  // path inside computeData now runs on the resolved tenant timezone.
  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const startOfDay   = (d)    => startOfDayInTz(d, tenantTz);
  const startOfMonth = (d)    => startOfMonthInTz(d, tenantTz);
  const addDays      = (d, n) => addDaysInTz(d, n);

  const locationId = (query && query.locationId) || null;
  const topN = Math.max(1, Math.min(MAX_TOP_N, Number(query?.topN) || DEFAULT_TOP_N));

  const now = new Date();
  // Pass the raw query string into startOfDay so it's interpreted as
  // "YYYY-MM-DD in tenant TZ" — wrapping in new Date(from) first parses
  // it as UTC midnight and we'd lose the day to the PREVIOUS tenant-TZ day.
  const fromDate = from ? startOfDay(from) : startOfMonth(now);
  const toDate = to ? startOfDay(to) : startOfDay(now);
  const numDays = Math.max(1, Math.round((toDate - fromDate) / DAY_MS) + 1);
  const safeNumDays = Math.min(numDays, MAX_DAYS);
  const windowEnd = addDays(fromDate, safeNumDays);

  const charges = await prisma.rentalAgreementCharge.findMany({
    where: buildChargeWhere({ tenantId, locationId, gte: fromDate, lt: windowEnd }),
    select: {
      id: true,
      name: true,
      code: true,
      chargeType: true,
      total: true,
      rentalAgreement: { select: { pickupAt: true } },
    },
  });

  const agg = aggregate(charges, topN, tenantTz);

  return {
    range: { from: fromDate.toISOString(), to: addDays(windowEnd, -1).toISOString() },
    totals: {
      salesAmount: agg.salesAmount,
      taxAmount: agg.taxAmount,
      depositAmount: agg.depositAmount,
      totalAmount: moneyRound(agg.salesAmount + agg.taxAmount),
      chargeCount: charges.length,
      salesChargeCount: agg.salesChargeCount,
      taxChargeCount: agg.taxChargeCount,
      depositChargeCount: agg.depositChargeCount,
    },
    topCategories: agg.topCategories,
    taxBreakdown: agg.taxBreakdown,
    depositBreakdown: agg.depositBreakdown,
    peakDay: agg.peakDay,
    categoryCount: agg.distinctCategoryCount,
    topN,
    tenantTimeZone: tenantTz,
    filters: { locationId },
    truncated: numDays > MAX_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Drill-down — charges for one or more category names
// ---------------------------------------------------------------------------

async function categoryDrillDownHandler(req, res, { tenantId }) {
  const prisma = await resolveDefaultPrisma();
  const tenantTz = await resolveTenantTimeZone(tenantId);
  const startOfDay   = (d)    => startOfDayInTz(d, tenantTz);
  const startOfMonth = (d)    => startOfMonthInTz(d, tenantTz);
  const addDays      = (d, n) => addDaysInTz(d, n);

  const namesParam = (req.query?.names || req.query?.name || '').toString();
  const names = namesParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    return res.status(400).json({ error: 'names query param required (comma-separated)' });
  }

  const locationId = req.query?.locationId ? String(req.query.locationId) : null;
  // Accept raw query strings (YYYY-MM-DD) or fall back to standard validation.
  const fromRaw = req.query?.from ? String(req.query.from) : null;
  const toRaw   = req.query?.to   ? String(req.query.to)   : null;
  if (fromRaw && Number.isNaN(new Date(fromRaw).getTime())) return res.status(400).json({ error: 'invalid from date' });
  if (toRaw   && Number.isNaN(new Date(toRaw).getTime()))   return res.status(400).json({ error: 'invalid to date' });

  const fromDate = fromRaw ? startOfDay(fromRaw) : startOfMonth(new Date());
  const toDate   = toRaw   ? startOfDay(toRaw)   : startOfDay(new Date());
  const windowEnd = addDays(toDate, 1);

  const charges = await prisma.rentalAgreementCharge.findMany({
    where: {
      selected: true,
      name: { in: names },
      rentalAgreement: {
        tenantId,
        pickupAt: { gte: fromDate, lt: windowEnd },
        ...(locationId ? { pickupLocationId: locationId } : {}),
      },
    },
    select: {
      id: true,
      name: true,
      code: true,
      chargeType: true,
      quantity: true,
      rate: true,
      total: true,
      rentalAgreement: {
        select: {
          id: true,
          agreementNumber: true,
          customerFirstName: true,
          customerLastName: true,
          pickupAt: true,
          pickupLocation: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { total: 'desc' },
  });

  const totalAmount = moneyRound(charges.reduce((acc, c) => acc + num(c.total), 0));

  return res.json({
    names,
    locationId,
    totalAmount,
    chargeCount: charges.length,
    charges: charges.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code || null,
      chargeType: c.chargeType,
      quantity: num(c.quantity),
      rate: num(c.rate),
      amount: num(c.total),
      agreementId: c.rentalAgreement?.id || null,
      agreementNumber: c.rentalAgreement?.agreementNumber || null,
      customerName: c.rentalAgreement
        ? `${c.rentalAgreement.customerFirstName || ''} ${c.rentalAgreement.customerLastName || ''}`.trim() || null
        : null,
      pickupAt: c.rentalAgreement?.pickupAt || null,
      pickupLocation: c.rentalAgreement?.pickupLocation?.name || null,
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
function pct(v) { return `${(v * 100).toFixed(1)}%`; }

function renderHtml(data) {
  const { totals, topCategories, taxBreakdown, depositBreakdown = [], peakDay } = data;
  const topCat = topCategories[0];

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Sales (pre-tax)</div><div class="strip-value">${money(totals.salesAmount)}</div><div style="font-size:9px;color:#5F5E5A">${totals.salesChargeCount} line items</div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Tax collected</div><div class="strip-value">${money(totals.taxAmount)}</div><div style="font-size:9px;color:#5F5E5A">${totals.taxChargeCount} lines</div></div>
    <div class="strip-card"><div class="strip-label">Top category</div><div class="strip-value" style="font-size:13px">${topCat ? escapeHtml(topCat.name) : '—'}<br><span style="color:#5F5E5A;font-size:10px">${topCat ? pct(topCat.pctOfSales) + ' · ' + money(topCat.amount) : ''}</span></div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Best day</div><div class="strip-value" style="font-size:13px">${escapeHtml(peakDay.label)}<br><span style="color:#5F5E5A;font-size:10px">${money(peakDay.amount)}</span></div></div>
  </div>`;

  let body = `${strip}<h3>Sales by category</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Category</th>
      <th class="num">Count</th>
      <th class="num">Total</th>
      <th class="num">Avg</th>
      <th class="num">% mix</th>
    </tr></thead><tbody>`;
  for (const c of topCategories) {
    body += `<tr>
      <td>${escapeHtml(c.name)}${c.isOther ? '' : (c.chargeType ? ` <span style="color:#5F5E5A;font-size:8px">${c.chargeType}</span>` : '')}</td>
      <td class="num">${c.count}</td>
      <td class="num"><strong>${money(c.amount)}</strong></td>
      <td class="num">${money(c.avgPerSale)}</td>
      <td class="num">${pct(c.pctOfSales)}</td>
    </tr>`;
  }
  body += `<tr style="background:#f1efe8">
    <td><strong>SALES TOTAL</strong></td>
    <td class="num"><strong>${totals.salesChargeCount}</strong></td>
    <td class="num"><strong>${money(totals.salesAmount)}</strong></td>
    <td class="num">—</td>
    <td class="num"><strong>100%</strong></td>
  </tr></tbody></table>`;

  if (taxBreakdown.length > 0) {
    body += `<h3>Tax collected</h3>
      <table style="font-size:10px"><thead><tr>
        <th style="text-align:left">Tax category</th>
        <th class="num">Count</th>
        <th class="num">Collected</th>
      </tr></thead><tbody>`;
    for (const t of taxBreakdown) {
      body += `<tr><td>${escapeHtml(t.name)}</td><td class="num">${t.count}</td><td class="num"><strong>${money(t.amount)}</strong></td></tr>`;
    }
    body += `<tr style="background:#f1efe8">
      <td><strong>TAX TOTAL</strong></td>
      <td class="num"><strong>${totals.taxChargeCount}</strong></td>
      <td class="num"><strong>${money(totals.taxAmount)}</strong></td>
    </tr></tbody></table>`;
  }

  if (depositBreakdown.length > 0) {
    body += `<h3>Deposits held (not revenue)</h3>
      <p style="font-size:9px;color:#5F5E5A;margin:0 0 6px">Security deposits are temporary holds — refunded on return. Shown here for reconciliation only.</p>
      <table style="font-size:10px"><thead><tr>
        <th style="text-align:left">Deposit type</th>
        <th class="num">Count</th>
        <th class="num">Held</th>
      </tr></thead><tbody>`;
    for (const d of depositBreakdown) {
      body += `<tr><td>${escapeHtml(d.name)}</td><td class="num">${d.count}</td><td class="num"><strong>${money(d.amount)}</strong></td></tr>`;
    }
    body += `<tr style="background:#f1efe8">
      <td><strong>DEPOSIT TOTAL</strong></td>
      <td class="num"><strong>${totals.depositChargeCount || 0}</strong></td>
      <td class="num"><strong>${money(totals.depositAmount || 0)}</strong></td>
    </tr></tbody></table>`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { totals, topCategories, taxBreakdown, depositBreakdown = [] } = data;
  const title = 'Sales by Category';
  const subtitle = `${data.range.from.slice(0, 10)} → ${data.range.to.slice(0, 10)}`;

  const sheets = [
    {
      name: 'Sales',
      bannerRows: [[title], [subtitle]],
      columns: [
        { header: 'Category',    key: 'name',       width: 28 },
        { header: 'Charge type', key: 'chargeType', width: 12 },
        { header: 'Count',       key: 'count',      width: 8,  type: 'integer' },
        { header: 'Total',       key: 'amount',     width: 14, type: 'currency' },
        { header: 'Avg / sale',  key: 'avgPerSale', width: 12, type: 'currency' },
        { header: '% of mix',    key: 'pctOfSales', width: 10, type: 'percent' },
      ],
      rows: topCategories.map((c) => ({
        name: c.name,
        chargeType: c.chargeType || '',
        count: c.count,
        amount: c.amount,
        avgPerSale: c.avgPerSale,
        pctOfSales: c.pctOfSales,
      })),
      footerRow: {
        name: 'SALES TOTAL',
        chargeType: '',
        count: totals.salesChargeCount,
        amount: totals.salesAmount,
        avgPerSale: 0,
        pctOfSales: 1,
      },
    },
  ];

  if (taxBreakdown.length > 0) {
    sheets.push({
      name: 'Tax',
      bannerRows: [['Tax collected'], [subtitle]],
      columns: [
        { header: 'Tax category', key: 'name',   width: 28 },
        { header: 'Count',        key: 'count',  width: 8,  type: 'integer' },
        { header: 'Collected',    key: 'amount', width: 14, type: 'currency' },
      ],
      rows: taxBreakdown,
      footerRow: { name: 'TAX TOTAL', count: totals.taxChargeCount, amount: totals.taxAmount },
    });
  }

  if (depositBreakdown.length > 0) {
    sheets.push({
      name: 'Deposits held',
      bannerRows: [['Deposits held (not revenue)'], [subtitle]],
      columns: [
        { header: 'Deposit type', key: 'name',   width: 28 },
        { header: 'Count',        key: 'count',  width: 8,  type: 'integer' },
        { header: 'Held',         key: 'amount', width: 14, type: 'currency' },
      ],
      rows: depositBreakdown,
      footerRow: { name: 'DEPOSIT TOTAL', count: totals.depositChargeCount || 0, amount: totals.depositAmount || 0 },
    });
  }

  return { title, subtitle, sheets };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'sales',
  title: 'Sales by Category',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/category', method: 'get', handler: categoryDrillDownHandler },
  ],
});

export const _salesInternal = {
  computeData,
  categoryDrillDownHandler,
  aggregate,
  startOfDay,
  startOfMonth,
  addDays,
  isoDay,
  dayLabel,
  TAX_CHARGE_TYPE,
  DEFAULT_TOP_N,
};
