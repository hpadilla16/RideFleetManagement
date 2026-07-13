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
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

const TAX = 'TAX';
const NON_REVENUE_CHARGE_TYPES = new Set(['TAX', 'DEPOSIT']);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 366;

// ---------------------------------------------------------------------------
// Helpers — see sales.report.js for the rationale on the tz-aware delegation.
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function moneyRound(n) { return Math.round(n * 100) / 100; }

/**
 * Pull the percent rate out of a tax category label like "Sales Tax (11.50%)".
 * Returns the rate as a decimal (0.115) or null if the name has no embedded
 * percent. Handles both "11.5%" and "11.50%" and tolerates surrounding text.
 */
function parseEmbeddedRate(name) {
  if (!name) return null;
  const match = String(name).match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return null;
  const pct = Number(match[1]);
  if (!Number.isFinite(pct)) return null;
  return pct / 100;
}

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
  // No tax was collected on a voided agreement or an abandoned draft —
  // same population rule as sales.report.js (keep the pair in sync).
  rentalAgreement.status = { notIn: ['CANCELLED', 'DRAFT'] };
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
// `tz` (2nd arg) defaults to PR so the unit tests keep working without
// piping a tenant lookup through them. Production callers (computeData)
// override with the resolved tenant timezone.
function aggregate(charges, tz = DEFAULT_TENANT_TIMEZONE) {
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
    const pickup = c.rentalAgreement?.pickupAt ? startOfDayInTz(new Date(c.rentalAgreement.pickupAt), tz) : null;
    const isoKey = pickup ? isoDayInTz(pickup, tz) : null;
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

  // Finalize categories. effectiveRate for a category is the rate that
  // applies to charges under THAT category — not collected / global taxable
  // base (which double-counts the base across multiple tax lines if any).
  // The category name embeds the configured rate (e.g. "Sales Tax (11.50%)"),
  // so we parse it from there. Fallback to a per-category derived rate if
  // the name has no embedded percent.
  const byCategory = Array.from(taxByName.values())
    .map((t) => ({
      ...t,
      pctOfTotal: taxCollected > 0 ? t.amount / taxCollected : 0,
      effectiveRate: parseEmbeddedRate(t.name) ?? (taxableBase > 0 ? t.amount / taxableBase : 0),
    }))
    .sort((a, b) => b.amount - a.amount);

  // Blended effective rate — weight each category's configured rate by the
  // tax collected from that category. If every category has the same rate,
  // this comes out to that rate exactly (no rounding drift from
  // collected / global-base, which can come up short when some taxable
  // charges didn't generate a corresponding tax line). If rates differ
  // across categories, this is a fair weighted average.
  const rateContribution = byCategory.reduce((acc, c) => acc + (c.effectiveRate || 0) * (c.amount || 0), 0);
  const blendedRate = taxCollected > 0 ? rateContribution / taxCollected : 0;

  return {
    byCategory,
    dayMap,
    totals: {
      taxCollected,
      taxableBase,
      nonTaxableRevenue,
      depositTotal,
      grossRevenue: moneyRound(taxCollected + taxableBase + nonTaxableRevenue),
      effectiveRate: blendedRate,
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

  // Resolve tenant TZ once + shadow the date helpers so every bucket inside
  // computeData (and aggregate via the `tz` arg) runs on the tenant zone.
  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const startOfDay   = (d)    => startOfDayInTz(d, tenantTz);
  const startOfMonth = (d)    => startOfMonthInTz(d, tenantTz);
  const addDays      = (d, n) => addDaysInTz(d, n);
  const isoDay       = (d)    => isoDayInTz(d, tenantTz);
  const dayLabel     = (d)    => dayLabelInTz(d, tenantTz);

  const locationId = (query && query.locationId) || null;

  const now = (deps && deps.now) || new Date();
  // Raw query string → tenant TZ midnight.
  const fromDate = from ? startOfDay(from) : startOfMonth(now);
  const toDate   = to   ? startOfDay(to)   : startOfDay(now);
  const numDays = Math.max(1, Math.round((toDate - fromDate) / DAY_MS) + 1);
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

  const agg = aggregate(charges, tenantTz);

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
    tenantTimeZone: tenantTz,
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
  // RAW strings into tz-aware helpers with the TENANT's tz — exactly like
  // computeData. `new Date('2026-07-01')` parses as UTC midnight (= Jun 30 in
  // PR) and the module-level helpers are pinned to PR, so this drill-down ran
  // one day early vs the aggregate (QA 2026-07-13; same class as commission).
  const fromRaw = req.query?.from ? String(req.query.from) : null;
  const toRaw   = req.query?.to   ? String(req.query.to)   : null;
  if (fromRaw && Number.isNaN(new Date(fromRaw).getTime())) return res.status(400).json({ error: 'invalid from date' });
  if (toRaw && Number.isNaN(new Date(toRaw).getTime()))     return res.status(400).json({ error: 'invalid to date' });

  const tenantTz = await resolveTenantTimeZone(tenantId);
  const now = new Date();
  const fromDate = fromRaw ? startOfDayInTz(fromRaw, tenantTz) : startOfMonthInTz(now, tenantTz);
  const toDate   = toRaw   ? startOfDayInTz(toRaw, tenantTz)   : startOfDayInTz(now, tenantTz);
  const windowEnd = addDaysInTz(toDate, 1);

  const charges = await prisma.rentalAgreementCharge.findMany({
    where: {
      selected: true,
      chargeType: TAX,
      name: { in: names },
      rentalAgreement: {
        tenantId,
        pickupAt: { gte: fromDate, lt: windowEnd },
        // Same population as the aggregate (buildChargeWhere) — no cancelled/draft.
        status: { notIn: ['CANCELLED', 'DRAFT'] },
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
  buildChargeWhere,
  categoryDrillDownHandler,
  TAX,
  NON_REVENUE_CHARGE_TYPES,
  MAX_DAYS,
};
