/**
 * Unpaid Balance — Round 28 (2026-05-23).
 *
 * Classic AR aging report. Pure right-now snapshot — no date range. Source is
 * RentalAgreement.balance > 0, filtered to non-cancelled agreements, optionally
 * scoped by pickupLocationId.
 *
 *   GET /api/reports/unpaid-balance?locationId=
 *     Returns { asOf, totals, buckets[], filters }
 *
 *   GET /api/reports/unpaid-balance/bucket?bucket=<key>&locationId=<?>
 *     Drill-down for one specific aging bucket (in case the UI wants to show
 *     a long list separately from the main payload).
 *
 * Aging buckets (anchor = RentalAgreement.returnAt):
 *
 *   CURRENT   — returnAt >= today (not yet due, in-progress rental)
 *   B1_30     — 1..30 days past returnAt
 *   B31_60    — 31..60 days past returnAt
 *   B61_90    — 61..90 days past returnAt
 *   B90_PLUS  — 91+ days past returnAt
 *
 * Triage order = 90_PLUS first → 61_90 → 31_60 → 1_30 → CURRENT.
 * Cancelled agreements are EXCLUDED — they shouldn't have a real balance owed.
 */

import { registerReport } from './reports-v2.routes.js';
import {
  DEFAULT_TENANT_TIMEZONE,
  startOfDayInTz,
  dayLabelInTz,
} from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const EXCLUDED_AGREEMENT_STATUSES = ['CANCELLED'];

// Triage-ordered (most urgent first)
const BUCKET_ORDER = [
  { key: 'B90_PLUS', label: '90+ days past due',     tone: 'critical' },
  { key: 'B61_90',   label: '61 – 90 days past due', tone: 'danger'   },
  { key: 'B31_60',   label: '31 – 60 days past due', tone: 'warning'  },
  { key: 'B1_30',    label: '1 – 30 days past due',  tone: 'warning'  },
  { key: 'CURRENT',  label: 'Current',               tone: 'neutral'  },
];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

// 2026-05-26: tz-aware helpers. AR aging buckets pivot on tenant-local "today";
// previously these used server-local setHours, so a 9pm-PR snapshot run from
// a UTC droplet computed "today" as the next-day UTC date, miscategorizing
// borderline agreements (e.g. a returnAt = today 11pm PR could fall into B1_30
// instead of CURRENT).
function startOfDay(d, tz = DEFAULT_TENANT_TIMEZONE) { return startOfDayInTz(d, tz); }

function diffDays(target, today, tz = DEFAULT_TENANT_TIMEZONE) {
  return Math.round((startOfDay(target, tz) - today) / DAY_MS);
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

function dayLabel(d, tz = DEFAULT_TENANT_TIMEZONE) { return dayLabelInTz(d, tz); }
function timeLabel(d, tz = DEFAULT_TENANT_TIMEZONE) {
  const out = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  return out.replace(' AM', 'am').replace(' PM', 'pm').replace(' ', '');
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function moneyRound(n) { return Math.round(n * 100) / 100; }

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

function buildAgreementWhere({ tenantId, locationId }) {
  const where = {
    tenantId,
    balance: { gt: 0 },
    status: { notIn: EXCLUDED_AGREEMENT_STATUSES },
  };
  if (locationId) where.pickupLocationId = locationId;
  return where;
}

// ---------------------------------------------------------------------------
// Pure aggregation — exposed for unit tests
// ---------------------------------------------------------------------------

/**
 * Bucket a list of prisma-shaped agreements into the 5 aging buckets given
 * `now`. Bucket boundaries match the standard AR convention:
 *   - daysLate <= 0  → CURRENT
 *   - 1..30          → B1_30
 *   - 31..60         → B31_60
 *   - 61..90         → B61_90
 *   - 91+            → B90_PLUS
 */
function bucketAgreements(agreements, asOf = new Date(), tz = DEFAULT_TENANT_TIMEZONE) {
  const today = startOfDay(asOf, tz);
  const buckets = {
    CURRENT:  { count: 0, amount: 0, agreements: [] },
    B1_30:    { count: 0, amount: 0, agreements: [] },
    B31_60:   { count: 0, amount: 0, agreements: [] },
    B61_90:   { count: 0, amount: 0, agreements: [] },
    B90_PLUS: { count: 0, amount: 0, agreements: [] },
  };

  for (const a of agreements) {
    const ret = new Date(a.returnAt);
    // daysLate > 0 means past returnAt
    const daysLate = -diffDays(ret, today, tz);
    let key;
    if (daysLate <= 0) key = 'CURRENT';
    else if (daysLate <= 30) key = 'B1_30';
    else if (daysLate <= 60) key = 'B31_60';
    else if (daysLate <= 90) key = 'B61_90';
    else key = 'B90_PLUS';

    const row = formatRow(a, daysLate, tz);
    buckets[key].agreements.push(row);
    buckets[key].count += 1;
    buckets[key].amount = moneyRound(buckets[key].amount + row.balance);
  }

  // Sort agreements within each bucket by daysLate desc (oldest first within
  // a past-due bucket; for CURRENT, by returnAt asc so nearest-due is first).
  for (const k of Object.keys(buckets)) {
    if (k === 'CURRENT') {
      buckets[k].agreements.sort((a, b) => new Date(a.returnAt) - new Date(b.returnAt));
    } else {
      buckets[k].agreements.sort((a, b) => b.daysLate - a.daysLate);
    }
  }

  return buckets;
}

function formatRow(a, daysLate, tz = DEFAULT_TENANT_TIMEZONE) {
  const ret = new Date(a.returnAt);
  return {
    id: a.id,
    reservationId: a.reservationId || null,
    agreementNumber: a.agreementNumber || null,
    status: a.status,
    customerName: `${a.customerFirstName || ''} ${a.customerLastName || ''}`.trim() || null,
    customerPhone: a.customerPhone || null,
    customerEmail: a.customerEmail || null,
    vehicle: a.vehicle
      ? {
          plate: a.vehicle.plate || null,
          label: [a.vehicle.year, a.vehicle.make, a.vehicle.model].filter(Boolean).join(' ') || null,
        }
      : null,
    pickupLocation: a.pickupLocation?.name || null,
    returnAt: a.returnAt,
    returnLabel: `${dayLabel(ret, tz)} · ${timeLabel(ret, tz)}`,
    returnIso: isoDay(ret),
    daysLate, // positive = past due, 0 or negative = current
    balance: moneyRound(num(a.balance)),
  };
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const locationId = (query && query.locationId) || null;
  const asOf = (deps && deps.now) || new Date();

  const agreements = await prisma.rentalAgreement.findMany({
    where: buildAgreementWhere({ tenantId, locationId }),
    select: {
      id: true,
      reservationId: true,
      agreementNumber: true,
      status: true,
      returnAt: true,
      balance: true,
      customerFirstName: true,
      customerLastName: true,
      customerPhone: true,
      customerEmail: true,
      vehicle:        { select: { plate: true, year: true, make: true, model: true } },
      pickupLocation: { select: { id: true, name: true } },
    },
    orderBy: { returnAt: 'asc' },
  });

  const bucketsMap = bucketAgreements(agreements, asOf, tenantTz);

  // Build the ordered triage list (90+ first → Current last)
  const buckets = BUCKET_ORDER.map((b) => {
    const bm = bucketsMap[b.key];
    return {
      key: b.key,
      label: b.label,
      tone: b.tone,
      count: bm.count,
      amount: bm.amount,
      agreements: bm.agreements,
    };
  });

  const totalAmount = moneyRound(buckets.reduce((acc, b) => acc + b.amount, 0));
  const accountCount = buckets.reduce((acc, b) => acc + b.count, 0);
  const pastDueAmount = moneyRound(
    buckets.filter((b) => b.key !== 'CURRENT').reduce((acc, b) => acc + b.amount, 0)
  );
  const pastDueCount = buckets.filter((b) => b.key !== 'CURRENT').reduce((acc, b) => acc + b.count, 0);

  // Compute pctOfTotal per bucket
  for (const b of buckets) {
    b.pctOfTotal = totalAmount > 0 ? b.amount / totalAmount : 0;
  }

  // Oldest debt — max daysLate across past-due buckets
  let oldestDaysLate = 0;
  for (const b of buckets) {
    for (const r of b.agreements) {
      if (r.daysLate > oldestDaysLate) oldestDaysLate = r.daysLate;
    }
  }

  return {
    asOf: asOf.toISOString(),
    asOfLabel: `${dayLabel(asOf, tenantTz)} · ${timeLabel(asOf, tenantTz)}`,
    tenantTimeZone: tenantTz,
    totals: {
      totalAmount,
      accountCount,
      pastDueAmount,
      pastDueCount,
      pastDuePct: totalAmount > 0 ? pastDueAmount / totalAmount : 0,
      averageBalance: accountCount > 0 ? moneyRound(totalAmount / accountCount) : 0,
      oldestDaysLate,
    },
    buckets,
    filters: { locationId },
  };
}

// ---------------------------------------------------------------------------
// Drill-down — one bucket
// ---------------------------------------------------------------------------

async function bucketDrillDownHandler(req, res, { tenantId }) {
  const bucketKey = (req.query?.bucket || '').toString().toUpperCase();
  const validBuckets = new Set(BUCKET_ORDER.map((b) => b.key));
  if (!validBuckets.has(bucketKey)) {
    return res.status(400).json({ error: `bucket must be one of ${Array.from(validBuckets).join(', ')}` });
  }
  const out = await computeData(
    { tenantId, query: { locationId: req.query?.locationId || null } },
    {},
  );
  const bucket = out.buckets.find((b) => b.key === bucketKey);
  return res.json({
    asOf: out.asOf,
    bucket: bucket ? { key: bucket.key, label: bucket.label, tone: bucket.tone, count: bucket.count, amount: bucket.amount } : null,
    agreements: bucket?.agreements || [],
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
function pct(v) { return `${(num(v) * 100).toFixed(1)}%`; }

function renderHtml(data) {
  const { totals, buckets, asOfLabel } = data;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Total outstanding</div><div class="strip-value">${money(totals.totalAmount)}</div><div style="font-size:9px;color:#5F5E5A">${totals.accountCount} accounts</div></div>
    <div class="strip-card"><div class="strip-label">Average balance</div><div class="strip-value">${money(totals.averageBalance)}</div></div>
    <div class="strip-card heat-red"><div class="strip-label">Past due</div><div class="strip-value">${money(totals.pastDueAmount)}</div><div style="font-size:9px;color:#501313">${pct(totals.pastDuePct)} of total</div></div>
    <div class="strip-card heat-red"><div class="strip-label">Oldest debt</div><div class="strip-value">${totals.oldestDaysLate} days</div></div>
  </div>`;

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">As of ${escapeHtml(asOfLabel)}</p>
    <h3>Aging summary</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Bucket</th>
      <th class="num">Accounts</th>
      <th class="num">Amount</th>
      <th class="num">% of total</th>
    </tr></thead><tbody>`;
  for (const b of buckets) {
    body += `<tr>
      <td>${escapeHtml(b.label)}</td>
      <td class="num">${b.count}</td>
      <td class="num"><strong>${money(b.amount)}</strong></td>
      <td class="num">${pct(b.pctOfTotal)}</td>
    </tr>`;
  }
  body += `<tr style="background:#f1efe8">
    <td><strong>TOTAL</strong></td>
    <td class="num"><strong>${totals.accountCount}</strong></td>
    <td class="num"><strong>${money(totals.totalAmount)}</strong></td>
    <td class="num"><strong>100%</strong></td>
  </tr></tbody></table>`;

  for (const b of buckets) {
    if (b.count === 0) continue;
    body += `<h3>${escapeHtml(b.label.toUpperCase())} · ${b.count} · ${money(b.amount)}</h3>
      <table style="font-size:10px"><thead><tr>
        <th style="text-align:left">Customer</th>
        <th style="text-align:left">Agreement</th>
        <th style="text-align:left">Vehicle</th>
        <th style="text-align:left">Return</th>
        <th class="num">Days late</th>
        <th class="num">Balance</th>
      </tr></thead><tbody>`;
    for (const r of b.agreements) {
      const vehLabel = r.vehicle?.plate ? `[${r.vehicle.plate}] ${r.vehicle.label || ''}` : (r.vehicle?.label || '');
      body += `<tr>
        <td>${escapeHtml(r.customerName || '—')}${r.customerPhone ? ` · ${escapeHtml(r.customerPhone)}` : ''}</td>
        <td>${escapeHtml(r.agreementNumber || r.id)}</td>
        <td>${escapeHtml(vehLabel)}</td>
        <td>${escapeHtml(r.returnLabel)}</td>
        <td class="num">${r.daysLate > 0 ? r.daysLate : '—'}</td>
        <td class="num"><strong>${money(r.balance)}</strong></td>
      </tr>`;
    }
    body += `</tbody></table>`;
  }

  if (buckets.every((b) => b.count === 0)) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No outstanding balances. All accounts are paid up.</p>`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { buckets, totals, asOfLabel } = data;
  const title = 'Unpaid Balance';
  const subtitle = `As of ${asOfLabel}`;

  const columns = [
    { header: 'Bucket',       key: 'bucket',          width: 22 },
    { header: 'Customer',     key: 'customer',        width: 24 },
    { header: 'Phone',        key: 'phone',           width: 16 },
    { header: 'Agreement',    key: 'agreement',       width: 14 },
    { header: 'Vehicle plate',key: 'plate',           width: 12 },
    { header: 'Vehicle',      key: 'vehicle',         width: 22 },
    { header: 'Return',       key: 'returnLabel',     width: 22 },
    { header: 'Days late',    key: 'daysLate',        width: 10, type: 'integer' },
    { header: 'Balance',      key: 'balance',         width: 14, type: 'currency' },
    { header: 'Location',     key: 'location',        width: 18 },
  ];

  const rows = [];
  for (const b of buckets) {
    for (const r of b.agreements) {
      rows.push({
        bucket: b.label,
        customer: r.customerName || '',
        phone: r.customerPhone || '',
        agreement: r.agreementNumber || r.id,
        plate: r.vehicle?.plate || '',
        vehicle: r.vehicle?.label || '',
        returnLabel: r.returnLabel,
        daysLate: r.daysLate > 0 ? r.daysLate : 0,
        balance: r.balance,
        location: r.pickupLocation || '',
      });
    }
  }

  return {
    title,
    subtitle,
    sheets: [
      {
        name: 'Aging summary',
        bannerRows: [[title], [subtitle]],
        columns: [
          { header: 'Bucket',   key: 'bucket',  width: 22 },
          { header: 'Accounts', key: 'count',   width: 10, type: 'integer' },
          { header: 'Amount',   key: 'amount',  width: 14, type: 'currency' },
          { header: '% of total', key: 'pct',   width: 12, type: 'percent' },
        ],
        rows: buckets.map((b) => ({
          bucket: b.label,
          count: b.count,
          amount: b.amount,
          pct: b.pctOfTotal,
        })),
        footerRow: { bucket: 'TOTAL', count: totals.accountCount, amount: totals.totalAmount, pct: 1 },
      },
      {
        name: 'Accounts',
        bannerRows: [['Unpaid accounts'], [subtitle]],
        columns,
        rows,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'unpaid-balance',
  title: 'Unpaid Balance',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/bucket', method: 'get', handler: bucketDrillDownHandler },
  ],
});

export const _unpaidBalanceInternal = {
  computeData,
  bucketAgreements,
  bucketDrillDownHandler,
  formatRow,
  BUCKET_ORDER,
  EXCLUDED_AGREEMENT_STATUSES,
  startOfDay,
  diffDays,
};
