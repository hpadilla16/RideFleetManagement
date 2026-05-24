/**
 * Payments by Day — Round 27 (2026-05-23).
 *
 * Daily collected revenue grouped by payment method bucket, sourced from
 * RentalAgreementPayment (canonical "money captured against an agreement",
 * matches the landing-page snapshot).
 *
 *   GET /api/reports/payments-by-day?from=&to=&locationId=
 *     Returns { range, days[], totals, peak, paymentCount, methodTotals,
 *               topMethod, dailyAverage, filters, truncated }
 *
 *   GET /api/reports/payments-by-day/day?day=<iso>&locationId=<?>
 *     Drill-down: the specific payments paid on that day.
 *
 * Method buckets (6 enum values → 4 display buckets, AUTH_HOLD excluded):
 *
 *   CASH    = CASH
 *   CARD    = CARD
 *   DIGITAL = ZELLE · ATH_MOVIL · BANK_TRANSFER
 *   OTHER   = OTHER
 *
 *   (AUTH_HOLD is a security-deposit authorization — not real money captured —
 *    so it's excluded from every figure in this report. Same for VOID and
 *    REFUNDED payments; we filter to status='PAID' only.)
 *
 * Default window: 1st of current month → today. Cap at 92 days.
 */

import { registerReport } from './reports-v2.routes.js';

const METHOD_BUCKETS = {
  CASH:    ['CASH'],
  CARD:    ['CARD'],
  DIGITAL: ['ZELLE', 'ATH_MOVIL', 'BANK_TRANSFER'],
  OTHER:   ['OTHER'],
};

const BUCKET_ORDER = ['CASH', 'CARD', 'DIGITAL', 'OTHER'];

const METHOD_TO_BUCKET = (() => {
  const out = {};
  for (const [bucket, methods] of Object.entries(METHOD_BUCKETS)) {
    for (const m of methods) out[m] = bucket;
  }
  return out;
})();

const EXCLUDED_METHODS = new Set(['AUTH_HOLD']);
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 92;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

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

function moneyRound(n) {
  // Avoid float drift like 12.300000000001
  return Math.round(n * 100) / 100;
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

function buildPaymentWhere({ tenantId, locationId, gte, lt }) {
  const rentalAgreement = { tenantId };
  if (locationId) rentalAgreement.pickupLocationId = locationId;
  return {
    rentalAgreement,
    status: 'PAID',
    method: { notIn: Array.from(EXCLUDED_METHODS) },
    paidAt: { gte, lt },
  };
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, from, to, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const locationId = (query && query.locationId) || null;

  const now = new Date();
  const fromDate = from ? startOfDay(new Date(from)) : startOfMonth(now);
  const toDate = to ? startOfDay(new Date(to)) : startOfDay(now);
  const numDays = daysBetween(fromDate, toDate);
  const safeNumDays = Math.min(numDays, MAX_DAYS);
  const windowEnd = addDays(fromDate, safeNumDays);

  // Pre-populate day skeleton (so days with no payments render as 0)
  const days = [];
  for (let i = 0; i < safeNumDays; i++) {
    const d = addDays(fromDate, i);
    days.push({
      iso: isoDay(d),
      label: dayLabel(d),
      amounts: { CASH: 0, CARD: 0, DIGITAL: 0, OTHER: 0 },
      count: 0,
      total: 0,
    });
  }
  const dayIdxByIso = new Map(days.map((d, i) => [d.iso, i]));

  const payments = await prisma.rentalAgreementPayment.findMany({
    where: buildPaymentWhere({ tenantId, locationId, gte: fromDate, lt: windowEnd }),
    select: { amount: true, method: true, paidAt: true },
  });

  // Aggregate
  const methodTotals = { CASH: 0, CARD: 0, DIGITAL: 0, OTHER: 0 };
  for (const p of payments) {
    const day = startOfDay(new Date(p.paidAt));
    const iso = isoDay(day);
    const idx = dayIdxByIso.get(iso);
    if (idx === undefined) continue;
    const bucket = METHOD_TO_BUCKET[p.method] || 'OTHER';
    const amt = num(p.amount);
    days[idx].amounts[bucket] = moneyRound(days[idx].amounts[bucket] + amt);
    days[idx].total = moneyRound(days[idx].total + amt);
    days[idx].count += 1;
    methodTotals[bucket] = moneyRound(methodTotals[bucket] + amt);
  }

  // Roll up grand totals + peak
  let totalAmount = 0;
  let totalCount  = 0;
  let peakIdx = 0;
  for (let i = 0; i < days.length; i++) {
    totalAmount = moneyRound(totalAmount + days[i].total);
    totalCount += days[i].count;
    if (days[i].total > days[peakIdx].total) peakIdx = i;
  }
  const peak = days[peakIdx] || { iso: isoDay(fromDate), label: dayLabel(fromDate), total: 0 };

  // Top method by $
  let topMethodKey = 'CASH';
  let topMethodAmt = -1;
  for (const k of BUCKET_ORDER) {
    if (methodTotals[k] > topMethodAmt) {
      topMethodAmt = methodTotals[k];
      topMethodKey = k;
    }
  }
  const topMethodPct = totalAmount > 0 ? topMethodAmt / totalAmount : 0;

  const dailyAverage = days.length > 0 ? moneyRound(totalAmount / days.length) : 0;

  return {
    range: { from: fromDate.toISOString(), to: addDays(windowEnd, -1).toISOString() },
    days,
    totals: {
      amount: totalAmount,
      count: totalCount,
    },
    methodTotals,
    bucketOrder: BUCKET_ORDER,
    peak: { iso: peak.iso, label: peak.label, total: peak.total, count: peak.count },
    topMethod: { key: topMethodKey, amount: topMethodAmt, pct: topMethodPct },
    dailyAverage,
    filters: { locationId },
    truncated: numDays > MAX_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Drill-down: payments on a specific day
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

  const payments = await prisma.rentalAgreementPayment.findMany({
    where: buildPaymentWhere({ tenantId, locationId, gte: day, lt: dayEnd }),
    select: {
      id: true,
      method: true,
      amount: true,
      reference: true,
      status: true,
      paidAt: true,
      notes: true,
      rentalAgreement: {
        select: {
          id: true,
          agreementNumber: true,
          customerFirstName: true,
          customerLastName: true,
          pickupLocation: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { paidAt: 'asc' },
  });

  // Day totals for the drawer header
  const totalAmount = moneyRound(payments.reduce((acc, p) => acc + num(p.amount), 0));

  return res.json({
    day: { iso: isoDay(day), label: dayLabel(day) },
    locationId,
    totalAmount,
    paymentCount: payments.length,
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      bucket: METHOD_TO_BUCKET[p.method] || 'OTHER',
      amount: num(p.amount),
      reference: p.reference || null,
      status: p.status,
      paidAt: p.paidAt,
      notes: p.notes || null,
      agreementNumber: p.rentalAgreement?.agreementNumber || null,
      customerName: p.rentalAgreement
        ? `${p.rentalAgreement.customerFirstName || ''} ${p.rentalAgreement.customerLastName || ''}`.trim() || null
        : null,
      pickupLocation: p.rentalAgreement?.pickupLocation?.name || null,
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
  const { days, totals, methodTotals, peak, topMethod, dailyAverage } = data;
  const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Collected</div><div class="strip-value">${money(totals.amount)}</div><div style="font-size:9px;color:#5F5E5A">${totals.count} payments</div></div>
    <div class="strip-card"><div class="strip-label">Daily average</div><div class="strip-value">${money(dailyAverage)}</div></div>
    <div class="strip-card"><div class="strip-label">Top method</div><div class="strip-value" style="font-size:13px">${escapeHtml(topMethod.key)} · ${fmtPct(topMethod.pct)}<br><span style="color:#5F5E5A;font-size:10px">${money(topMethod.amount)}</span></div></div>
    <div class="strip-card"><div class="strip-label">Best day</div><div class="strip-value" style="font-size:13px">${escapeHtml(peak.label)}<br><span style="color:#5F5E5A;font-size:10px">${money(peak.total)}</span></div></div>
  </div>`;

  let body = `${strip}<h3>Daily payments by method</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Day</th>
      <th class="num">Cash</th>
      <th class="num">Card</th>
      <th class="num">Digital</th>
      <th class="num">Other</th>
      <th class="num">Count</th>
      <th class="num">Total</th>
    </tr></thead><tbody>`;
  for (const d of days) {
    body += `<tr>
      <td>${escapeHtml(d.label)}</td>
      <td class="num">${money(d.amounts.CASH)}</td>
      <td class="num">${money(d.amounts.CARD)}</td>
      <td class="num">${money(d.amounts.DIGITAL)}</td>
      <td class="num">${money(d.amounts.OTHER)}</td>
      <td class="num">${d.count}</td>
      <td class="num"><strong>${money(d.total)}</strong></td>
    </tr>`;
  }
  body += `<tr style="background:#f1efe8">
    <td><strong>TOTAL</strong></td>
    <td class="num"><strong>${money(methodTotals.CASH)}</strong></td>
    <td class="num"><strong>${money(methodTotals.CARD)}</strong></td>
    <td class="num"><strong>${money(methodTotals.DIGITAL)}</strong></td>
    <td class="num"><strong>${money(methodTotals.OTHER)}</strong></td>
    <td class="num"><strong>${totals.count}</strong></td>
    <td class="num"><strong>${money(totals.amount)}</strong></td>
  </tr></tbody></table>`;

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { days, totals, methodTotals } = data;
  const title = 'Payments by Day';
  const subtitle = `${data.range.from.slice(0, 10)} → ${data.range.to.slice(0, 10)}`;

  const columns = [
    { header: 'Day',      key: 'day',     width: 18 },
    { header: 'Cash',     key: 'CASH',    width: 12, type: 'currency' },
    { header: 'Card',     key: 'CARD',    width: 12, type: 'currency' },
    { header: 'Digital',  key: 'DIGITAL', width: 12, type: 'currency' },
    { header: 'Other',    key: 'OTHER',   width: 12, type: 'currency' },
    { header: 'Count',    key: 'count',   width: 8,  type: 'integer'  },
    { header: 'Total',    key: 'total',   width: 12, type: 'currency' },
  ];

  const rows = days.map((d) => ({
    day: d.label,
    CASH: d.amounts.CASH,
    CARD: d.amounts.CARD,
    DIGITAL: d.amounts.DIGITAL,
    OTHER: d.amounts.OTHER,
    count: d.count,
    total: d.total,
  }));

  const footerRow = {
    day: 'TOTAL',
    CASH: methodTotals.CASH,
    CARD: methodTotals.CARD,
    DIGITAL: methodTotals.DIGITAL,
    OTHER: methodTotals.OTHER,
    count: totals.count,
    total: totals.amount,
  };

  return {
    title,
    subtitle,
    sheets: [{
      name: 'Payments',
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
  slug: 'payments-by-day',
  title: 'Payments by Day',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/day', method: 'get', handler: dayDrillDownHandler },
  ],
});

export const _paymentsByDayInternal = {
  computeData,
  dayDrillDownHandler,
  METHOD_BUCKETS,
  METHOD_TO_BUCKET,
  BUCKET_ORDER,
  EXCLUDED_METHODS,
  startOfDay,
  addDays,
  isoDay,
  dayLabel,
  moneyRound,
};
