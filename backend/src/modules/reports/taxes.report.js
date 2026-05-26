/**
 * Taxes — Round 31 (2026-05-23).
 *
 * Sibling of the Sales report — isolates TAX-type charges from the same
 * RentalAgreementCharge ledger and pairs them with the taxable base for the
 * accountant.
 *
 *   GET /api/reports/taxes?from=&to=&locationId=
 *     Returns { range, totals, byCategory[], byDay[], filters, truncated }
 *
 *   GET /api/reports/taxes/category?names=<csv>&from=&to=&locationId=
 *     Drill-down: the individual TAX charges in one or more named categories.
 *
 * Sources:
 *   - tax COLLECTED  = sum of RentalAgreementCharge where chargeType='TAX'
 *                       and selected=true
 *   - taxable BASE   = sum of RentalAgreementCharge where taxable=true
 *                       and chargeType NOT IN ('TAX','DEPOSIT')
 *                       and selected=true
 *   - non-taxable    = sum of RentalAgreementCharge where taxable=false
 *                       and chargeType NOT IN ('TAX','DEPOSIT')
 *                       and selected=true (informational)
 *
 * Date axis: rentalAgreement.pickupAt (matches sales-by-category so figures
 * tie out cleanly).
 *
 * Default window: this month → today. Cap at 366 days.
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

const TAX = 'TAX';
const NON_REVENUE_CHARGE_TYPES = new Set(['TAX', 'DEPOSIT']);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 366;

// ---------------------------------------------------------------------------
// Helpers — see sales.report.js for the rationale on the tz-aware delegation.
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
  return { selected: true, rentalAgreement };
}

// ---------------------------------------------------------------------------
// Pure aggregation — exposed for unit tests
// ---------------------------------------------------------------------------

/**
 * Given a flat list of selected charges with { name, chargeType, taxable,
 * total, rentalAgreement: { id, pickupAt } }, return:
 *   - byCategory: TAX charges grouped by name (sorted by amount desc)
 *   - byDay:      Map of iso → { taxCollected, taxableBase } for chart
 *   - totals:     fleet-level rollup
 */
function aggregate(charges) {
  const taxByName = new Map();
  const dayMap = new Map(); // iso → { taxCollected, taxableBase }
  let taxCollected = 0;
  let taxableBase = 0;
  let nonTaxableRevenue = 0;
  let depositTotal = 0;
  const taxedAgreementIds = new Set();
  const allAgreementIds = new Set();

  for (const c of charges) {
    const amt = num(c.total);
    const ct = String(c.chargeType || '').toUpperCase();
    const agreementId = c.rentalAgreement?.id || null;
    const pickup = c.rentalAgreement?.pickupAt ? startOfDay(new Date(c.rentalAgreement.pickupAt)) : null;
    const isoKey = pickup ? isoDay(pickup) : null;
    if (agreementId) allAgreementIds.add(agreementId);

    if (ct === TAX) {
      // Tax line
      taxCollected = moneyRound(taxCollected + amt);
      if (agreementId) taxedAgreementIds.add(agreementId);
      const key = (c.name || '(uncategorized tax)').trim() || '(uncategorized tax)';
      if (!taxByName.has(key)) taxByName.set(key, { name: key, code: c.code || null, count: 0, amount: 0 });
      const t = taxByName.get(key);
      t.amount = moneyRound(t.amount + amt);
      t.count += 1;
      if (isoKey) {
        if (!dayMap.has(isoKey)) dayMap.set(isoKey, { iso: isoKey, taxCollected: 0, taxableBase: 0 });
        dayMap.get(isoKey).taxCollected = moneyRound(dayMap.get(isoKey).taxCollected + amt);
      }
      continue;
    }
    if (ct === 'DEPOSIT') {
      depositTotal = moneyRound(depositTotal + amt);
      continue;
    }
    // Revenue line — split by taxable flag
    if (c.taxable === true) {
      taxableBase = moneyRound(taxableBase + amt);
      if (isoKey) {
        if (!dayMap.has(isoKey)) dayMap.set(isoKey, { iso: isoKey, taxCollected: 0, taxableBase: 0 });
        dayMap.get(isoKey).taxableBase = moneyRound(dayMap.get(isoKey).taxableBase + amt);
      }
    } else {
      nonTaxableRevenue = moneyRound(nonTaxableRevenue + amt);
    }
  }

  // Finalize categories
  const byCategory = Array.from(taxByName.values())
    .map((t) => ({
      ...t,
      pctOfTotal: taxCollected > 0 ? t.amount / taxCollected : 0,
      effectiveRate: taxableBase > 0 ? t.amount / taxableBase : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  return {
    byCategory,
    dayMap,
    totals: {
      taxCollected,
      taxableBase,
      nonTaxableRevenue,
      depositTotal,
      grossRevenue: moneyRound(taxCollected + taxableBase + nonTaxableRevenue),
      effectiveRate: taxableBase > 0 ? taxCollected / taxableBase : 0,
      taxedAgreementCount: taxedAgreementIds.size,
      totalAgreementCount: allAgreementIds.size,
      categoryCount: byCategory.length,
    },
  };
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, from, to, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const locationId = (query && query.locationId) || null;

  const now = (deps && deps.now) || new Date();
  // Pass the raw query string into startOfDay so it's interpreted as
  // "YYYY-MM-DD in tenant TZ" — wrapping in new Date(from) first parses
  // it as UTC midnight and we'd lose the day to the PREVIOUS PR-TZ day.
  const fromDate = from ? startOfDay(from) : startOfMonth(now);
  const toDate   = to   ? startOfDay(to)   : startOfDay(now);
  const numDays = daysBetween(fromDate, toDate);
  const safeNumDays = Math.min(numDays, MAX_DAYS);
  const windowEnd = addDays(fromDate, safeNumDays);
  const truncated = numDays > MAX_DAYS;

  const charges = await prisma.rentalAgreementCharge.findMany({
    where: buildChargeWhere({ tenantId, locationId, gte: fromDate, lt: windowEnd }),
    select: {
      id: true,
      name: true,
      code: true,
      chargeType: true,
      taxable: true,
      total: true,
      rentalAgreement: { select: { id: true, pickupAt: true } },
    },
  });

  const agg = aggregate(charges);

  // Build day skeleton so empty days render as zeros
  const byDay = [];
  for (let i = 0; i < safeNumDays; i++) {
    const d = addDays(fromDate, i);
    const iso = isoDay(d);
    const existing = agg.dayMap.get(iso);
    byDay.push({
      iso,
      label: dayLabel(d),
      taxCollected: existing?.taxCollected || 0,
      taxableBase: existing?.taxableBase || 0,
    });
  }

  // Peak day by tax collected
  let peakDay = null;
  for (const d of byDay) {
    if (!peakDay || d.taxCollected > peakDay.taxCollected) peakDay = d;
  }

  return {
    range: { from: fromDate.toISOString(), to: addDays(windowEnd, -1).toISOString() },
    rangeDays: safeNumDays,
    truncated,
    totals: agg.totals,
    byCategory: agg.byCategory,
    byDay,
    peakDay: peakDay && peakDay.taxCollected > 0 ? peakDay : null,
    filters: { locationId },
  };
}

// ---------------------------------------------------------------------------
// Drill-down — TAX charges in one or more named categories
// ---------------------------------------------------------------------------

async function categoryDrillDownHandler(req, res, { tenantId }) {
  const prisma = await resolveDefaultPrisma();
  const namesParam = (req.query?.names || req.query?.name || '').toString();
  const names = namesParam.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    return res.status(400).json({ error: 'names query param required (comma-separated)' });
  }

  const locationId = req.query?.locationId ? String(req.query.locationId) : null;
  const from = req.query?.from ? new Date(req.query.from) : null;
  const to   = req.query?.to   ? new Date(req.query.to)   : null;
  if (from && Number.isNaN(from.getTime())) return res.status(400).json({ error: 'invalid from date' });
  if (to && Number.isNaN(to.getTime()))     return res.status(400).json({ error: 'invalid to date' });

  const now = new Date();
  const fromDate = from ? startOfDay(from) : startOfMonth(now);
  const toDate   = to   ? startOfDay(to)   : startOfDay(now);
  const windowEnd = addDays(toDate, 1);

  const charges = await prisma.rentalAgreementCharge.findMany({
    where: {
      selected: true,
      chargeType: TAX,
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
          pickupLocation: { select: { name: true } },
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
function pct(v) { return `${(num(v) * 100).toFixed(2)}%`; }

function renderHtml(data) {
  const { totals, byCategory, range } = data;

  const strip = `<div class="strip">
    <div class="strip-card heat-amber"><div class="strip-label">Tax collected</div><div class="strip-value">${money(totals.taxCollected)}</div></div>
    <div class="strip-card"><div class="strip-label">Taxable base</div><div class="strip-value">${money(totals.taxableBase)}</div></div>
    <div class="strip-card"><div class="strip-label">Effective rate</div><div class="strip-value">${pct(totals.effectiveRate)}</div></div>
    <div class="strip-card"><div class="strip-label">Taxed agreements</div><div class="strip-value">${totals.taxedAgreementCount}</div><div style="font-size:9px;color:#5F5E5A">of ${totals.totalAgreementCount}</div></div>
  </div>`;

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">${escapeHtml(range.from.slice(0,10))} → ${escapeHtml(range.to.slice(0,10))}</p>
    <h3>Tax collected by category</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Category</th>
      <th class="num">Count</th>
      <th class="num">Collected</th>
      <th class="num">Effective rate</th>
      <th class="num">% of tax</th>
    </tr></thead><tbody>`;
  for (const c of byCategory) {
    body += `<tr>
      <td><strong>${escapeHtml(c.name)}</strong>${c.code ? ` <span style="color:#5F5E5A;font-size:8px">${escapeHtml(c.code)}</span>` : ''}</td>
      <td class="num">${c.count}</td>
      <td class="num"><strong>${money(c.amount)}</strong></td>
      <td class="num">${pct(c.effectiveRate)}</td>
      <td class="num">${pct(c.pctOfTotal)}</td>
    </tr>`;
  }
  body += `<tr style="background:#f1efe8">
    <td><strong>TOTAL</strong></td>
    <td class="num"><strong>${byCategory.reduce((acc, c) => acc + c.count, 0)}</strong></td>
    <td class="num"><strong>${money(totals.taxCollected)}</strong></td>
    <td class="num"><strong>${pct(totals.effectiveRate)}</strong></td>
    <td class="num"><strong>100%</strong></td>
  </tr></tbody></table>`;

  if (byCategory.length === 0) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No tax collected in this window.</p>`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { byCategory, totals, range } = data;
  const title = 'Taxes';
  const subtitle = `${range.from.slice(0,10)} → ${range.to.slice(0,10)}`;

  return {
    title,
    subtitle,
    sheets: [{
      name: 'By category',
      bannerRows: [[title], [subtitle]],
      columns: [
        { header: 'Tax category',   key: 'name',          width: 28 },
        { header: 'Code',           key: 'code',          width: 10 },
        { header: 'Count',          key: 'count',         width: 8,  type: 'integer'  },
        { header: 'Collected',      key: 'amount',        width: 14, type: 'currency' },
        { header: 'Effective rate', key: 'effectiveRate', width: 14, type: 'percent'  },
        { header: '% of tax',       key: 'pctOfTotal',    width: 10, type: 'percent'  },
      ],
      rows: byCategory.map((c) => ({
        name: c.name,
        code: c.code || '',
        count: c.count,
        amount: c.amount,
        effectiveRate: c.effectiveRate,
        pctOfTotal: c.pctOfTotal,
      })),
      footerRow: {
        name: 'TOTAL',
        code: '',
        count: byCategory.reduce((acc, c) => acc + c.count, 0),
        amount: totals.taxCollected,
        effectiveRate: totals.effectiveRate,
        pctOfTotal: 1,
      },
    }],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'taxes',
  title: 'Taxes',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/category', method: 'get', handler: categoryDrillDownHandler },
  ],
});

export const _taxesInternal = {
  computeData,
  aggregate,
  categoryDrillDownHandler,
  TAX,
  NON_REVENUE_CHARGE_TYPES,
  MAX_DAYS,
};
