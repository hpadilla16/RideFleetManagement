/**
 * Toll Report — per Location — Round 30 (2026-05-23).
 *
 * Tolls aggregated by toll plaza (TollTransaction.location string) for a date
 * window. Sibling of toll-per-vehicle (same source, different grouping axis).
 *
 *   GET /api/reports/toll-per-location?from=&to=&locationId=
 *     Returns { range, totals, plazas[], filters, truncated }
 *
 *   GET /api/reports/toll-per-location/transactions?plaza=<name>&from=&to=&locationId=
 *     Drill-down: individual transactions at a single plaza. `plaza` may be
 *     "__unknown__" to fetch transactions without a recorded plaza.
 *
 * Notes on "location":
 *   - The grouping axis is the toll PLAZA (the road/highway charging the toll).
 *     This is a free-form string on TollTransaction with no FK link.
 *   - The `locationId` FILTER, in contrast, narrows by the vehicle's home
 *     location (matches the convention of every other fleet report). Same
 *     behavior as toll-per-vehicle: unmatched transactions are excluded when
 *     a location filter is active.
 *
 * Default window: last 30 days. Cap at 365 days.
 */

import { registerReport } from './reports-v2.routes.js';
import {
  DEFAULT_TENANT_TIMEZONE,
  startOfDayInTz,
  addDaysInTz,
  isoDayInTz,
  dayLabelInTz,
} from '../../lib/date-utils.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 365;
const UNKNOWN_PLAZA_KEY = '__unknown__';
const UNKNOWN_PLAZA_LABEL = 'Unknown plaza';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function moneyRound(n) { return Math.round(n * 100) / 100; }

// 2026-05-26: tz-aware date helpers (see sales.report.js for rationale).
function startOfDay(d) { return startOfDayInTz(d, DEFAULT_TENANT_TIMEZONE); }
function addDays(d, n) { return addDaysInTz(d, n); }
function isoDay(d)     { return isoDayInTz(d, DEFAULT_TENANT_TIMEZONE); }
function dayLabel(d)   { return dayLabelInTz(d, DEFAULT_TENANT_TIMEZONE); }

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

function buildTransactionWhere({ tenantId, locationId, gte, lt }) {
  const where = { tenantId, transactionAt: { gte, lt } };
  if (locationId) {
    // When narrowing by tenant location, we can only attribute matched (has-vehicle)
    // transactions. Unmatched rows have no home location to filter by.
    where.vehicle = { homeLocationId: locationId };
  }
  return where;
}

// ---------------------------------------------------------------------------
// Pure aggregation — exposed for unit testing
// ---------------------------------------------------------------------------

/**
 * Bucket prisma-shaped TollTransactions by plaza (location string).
 * Transactions with no plaza go into the UNKNOWN_PLAZA bucket.
 *
 * Returns plazas[] sorted by total amount desc. Each plaza carries:
 *   { key, label, count, amount, averagePerTxn,
 *     topVehicles: [{ vehicleId, plate, label, count, amount }] }
 */
function aggregateByPlaza(transactions) {
  const byPlaza = new Map();
  for (const t of transactions) {
    const rawKey = (t.location || '').trim();
    const key = rawKey || UNKNOWN_PLAZA_KEY;
    const label = rawKey || UNKNOWN_PLAZA_LABEL;
    if (!byPlaza.has(key)) {
      byPlaza.set(key, {
        key,
        label,
        count: 0,
        amount: 0,
        vehicleAgg: new Map(), // vehicleId -> { plate, label, count, amount }
      });
    }
    const p = byPlaza.get(key);
    const amt = num(t.amount);
    p.count += 1;
    p.amount = moneyRound(p.amount + amt);

    if (t.vehicleId) {
      if (!p.vehicleAgg.has(t.vehicleId)) {
        p.vehicleAgg.set(t.vehicleId, {
          vehicleId: t.vehicleId,
          plate: t.vehicle?.plate || null,
          label: t.vehicle ? [t.vehicle.year, t.vehicle.make, t.vehicle.model].filter(Boolean).join(' ') || null : null,
          count: 0,
          amount: 0,
        });
      }
      const v = p.vehicleAgg.get(t.vehicleId);
      v.count += 1;
      v.amount = moneyRound(v.amount + amt);
    }
  }

  // Finalize: derive averages and top-3 vehicles, drop maps
  const plazas = Array.from(byPlaza.values()).map((p) => {
    const topVehicles = Array.from(p.vehicleAgg.values())
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 3);
    return {
      key: p.key,
      label: p.label,
      isUnknown: p.key === UNKNOWN_PLAZA_KEY,
      count: p.count,
      amount: p.amount,
      averagePerTxn: p.count > 0 ? moneyRound(p.amount / p.count) : 0,
      topVehicles,
    };
  });
  plazas.sort((a, b) => b.amount - a.amount);
  return plazas;
}

function formatTransaction(t) {
  return {
    id: t.id,
    transactionAt: t.transactionAt,
    transactionLabel: t.transactionAt ? `${dayLabel(new Date(t.transactionAt))}` : null,
    amount: num(t.amount),
    location: t.location || null,
    lane: t.lane || null,
    direction: t.direction || null,
    plateRaw: t.plateRaw || null,
    tagRaw: t.tagRaw || null,
    status: t.status,
    needsReview: !!t.needsReview,
    vehicleId: t.vehicleId || null,
    reservationId: t.reservationId || null,
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
  // Raw query strings → tenant-TZ midnight (don't wrap in new Date first).
  const fromDate = from ? startOfDay(from) : addDays(startOfDay(now), -29);
  const toDate   = to   ? startOfDay(to)   : startOfDay(now);
  const numDays = daysBetween(fromDate, toDate);
  const safeNumDays = Math.min(numDays, MAX_DAYS);
  const windowEnd = addDays(fromDate, safeNumDays);
  const truncated = numDays > MAX_DAYS;

  const transactions = await prisma.tollTransaction.findMany({
    where: buildTransactionWhere({ tenantId, locationId, gte: fromDate, lt: windowEnd }),
    select: {
      id: true, vehicleId: true, amount: true, transactionAt: true, location: true,
      vehicle: {
        select: {
          plate: true, year: true, make: true, model: true,
        },
      },
    },
  });

  const plazas = aggregateByPlaza(transactions);

  const totalAmount = moneyRound(plazas.reduce((acc, p) => acc + p.amount, 0));
  const totalCount = plazas.reduce((acc, p) => acc + p.count, 0);
  const unknown = plazas.find((p) => p.isUnknown);
  const knownPlazaCount = plazas.length - (unknown ? 1 : 0);
  const busiestPlaza = plazas.find((p) => !p.isUnknown) || null;

  return {
    range: { from: fromDate.toISOString(), to: addDays(windowEnd, -1).toISOString() },
    rangeDays: safeNumDays,
    truncated,
    totals: {
      amount: totalAmount,
      count: totalCount,
      plazaCount: knownPlazaCount,
      unknownCount: unknown ? unknown.count : 0,
      unknownAmount: unknown ? unknown.amount : 0,
      busiestPlazaLabel: busiestPlaza?.label || null,
      busiestPlazaAmount: busiestPlaza?.amount || 0,
    },
    plazas,
    filters: { locationId },
  };
}

// ---------------------------------------------------------------------------
// Drill-down — transactions at a single plaza
// ---------------------------------------------------------------------------

async function plazaDrillDownHandler(req, res, { tenantId }) {
  const prisma = await resolveDefaultPrisma();
  const plazaRaw = (req.query?.plaza || '').toString();
  const locationId = req.query?.locationId ? String(req.query.locationId) : null;
  const from = req.query?.from ? new Date(req.query.from) : null;
  const to = req.query?.to ? new Date(req.query.to) : null;

  if (!plazaRaw) return res.status(400).json({ error: 'plaza query param required' });
  if (from && Number.isNaN(from.getTime())) return res.status(400).json({ error: 'invalid from' });
  if (to && Number.isNaN(to.getTime()))     return res.status(400).json({ error: 'invalid to' });

  const now = new Date();
  const fromDate = from ? startOfDay(from) : addDays(startOfDay(now), -29);
  const toDate   = to   ? startOfDay(to)   : startOfDay(now);
  const windowEnd = addDays(toDate, 1);

  const where = {
    tenantId,
    transactionAt: { gte: fromDate, lt: windowEnd },
  };
  if (plazaRaw === UNKNOWN_PLAZA_KEY) {
    where.OR = [{ location: null }, { location: '' }];
  } else {
    where.location = plazaRaw;
  }
  if (locationId) where.vehicle = { homeLocationId: locationId };

  const transactions = await prisma.tollTransaction.findMany({
    where,
    select: {
      id: true, vehicleId: true, reservationId: true,
      amount: true, transactionAt: true, location: true, lane: true, direction: true,
      plateRaw: true, tagRaw: true, status: true, needsReview: true,
    },
    orderBy: { transactionAt: 'desc' },
    take: 500,
  });

  const totalAmount = moneyRound(transactions.reduce((acc, t) => acc + num(t.amount), 0));
  const plazaLabel = plazaRaw === UNKNOWN_PLAZA_KEY ? UNKNOWN_PLAZA_LABEL : plazaRaw;

  return res.json({
    plaza: plazaLabel,
    plazaKey: plazaRaw,
    locationId,
    totalAmount,
    transactionCount: transactions.length,
    transactions: transactions.map(formatTransaction),
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
  const { totals, plazas, range } = data;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Total tolls</div><div class="strip-value">${money(totals.amount)}</div><div style="font-size:9px;color:#5F5E5A">${totals.count} transactions</div></div>
    <div class="strip-card"><div class="strip-label">Plazas hit</div><div class="strip-value">${totals.plazaCount}</div></div>
    <div class="strip-card"><div class="strip-label">Busiest plaza</div><div class="strip-value" style="font-size:13px">${escapeHtml(totals.busiestPlazaLabel || '—')}<br><span style="color:#5F5E5A;font-size:10px">${money(totals.busiestPlazaAmount)}</span></div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Unknown plaza</div><div class="strip-value">${totals.unknownCount}</div><div style="font-size:9px;color:#412402">${money(totals.unknownAmount)}</div></div>
  </div>`;

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">${escapeHtml(range.from.slice(0,10))} → ${escapeHtml(range.to.slice(0,10))}</p>
    <h3>By plaza</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Plaza</th>
      <th class="num">Tolls</th>
      <th class="num">Total</th>
      <th class="num">Avg</th>
      <th style="text-align:left">Top vehicles</th>
    </tr></thead><tbody>`;
  for (const p of plazas) {
    const tops = p.topVehicles
      .map((v) => `${escapeHtml(v.plate || '—')} (${v.count})`)
      .join(', ');
    body += `<tr>
      <td><strong>${escapeHtml(p.label)}</strong></td>
      <td class="num">${p.count}</td>
      <td class="num"><strong>${money(p.amount)}</strong></td>
      <td class="num">${money(p.averagePerTxn)}</td>
      <td>${tops || '—'}</td>
    </tr>`;
  }
  body += `</tbody></table>`;

  if (plazas.length === 0) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No toll transactions in this window.</p>`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { plazas, range } = data;
  const title = 'Toll Report — per Location';
  const subtitle = `${range.from.slice(0,10)} → ${range.to.slice(0,10)}`;

  return {
    title,
    subtitle,
    sheets: [{
      name: 'By plaza',
      bannerRows: [[title], [subtitle]],
      columns: [
        { header: 'Plaza',         key: 'label',         width: 28 },
        { header: 'Tolls',         key: 'count',         width: 10, type: 'integer'  },
        { header: 'Total',         key: 'amount',        width: 12, type: 'currency' },
        { header: 'Avg / toll',    key: 'averagePerTxn', width: 12, type: 'currency' },
        { header: 'Top vehicles',  key: 'topVehicles',   width: 36 },
      ],
      rows: plazas.map((p) => ({
        label: p.label,
        count: p.count,
        amount: p.amount,
        averagePerTxn: p.averagePerTxn,
        topVehicles: p.topVehicles.map((v) => `${v.plate || '—'} (${v.count})`).join('; '),
      })),
      footerRow: {
        label: 'TOTAL',
        count: plazas.reduce((acc, p) => acc + p.count, 0),
        amount: moneyRound(plazas.reduce((acc, p) => acc + p.amount, 0)),
        averagePerTxn: 0,
        topVehicles: '',
      },
    }],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'toll-per-location',
  title: 'Toll Report — per Location',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/transactions', method: 'get', handler: plazaDrillDownHandler },
  ],
});

export const _tollPerLocationInternal = {
  computeData,
  aggregateByPlaza,
  plazaDrillDownHandler,
  formatTransaction,
  UNKNOWN_PLAZA_KEY,
  UNKNOWN_PLAZA_LABEL,
  MAX_DAYS,
};
