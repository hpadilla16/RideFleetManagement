/**
 * Toll Report — per Vehicle — Round 30 (2026-05-23).
 *
 * Tolls aggregated by vehicle for a date window. Sibling of toll-per-location
 * (which is the same data sliced by toll plaza instead). Source:
 * TollTransaction.transactionAt.
 *
 *   GET /api/reports/toll-per-vehicle?from=&to=&locationId=
 *     Returns { range, totals, vehicles[], unmatched, filters, truncated }
 *
 *   GET /api/reports/toll-per-vehicle/transactions?vehicleId=&from=&to=&locationId=
 *     Drill-down: individual transactions for a vehicle (or unmatched=true
 *     for the no-vehicleId bucket).
 *
 * Default window: last 30 days. Cap at 365 days. Unmatched transactions
 * (vehicleId is null) get their own bucket so the user can see reconciliation
 * work pending — they affect totals but aren't credited to any vehicle.
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

function buildTransactionWhere({ tenantId, locationId, gte, lt, vehicleScope }) {
  const where = {
    tenantId,
    transactionAt: { gte, lt },
  };
  // vehicleScope = 'matched' (vehicleId set), 'unmatched' (null), or undefined (both)
  if (vehicleScope === 'unmatched') where.vehicleId = null;
  if (vehicleScope === 'matched')   where.vehicleId = { not: null };

  // Location filter targets the Vehicle's home location. This means unmatched
  // transactions are NOT returned when a location filter is active (we can't
  // attribute them anywhere). The frontend will indicate this in the empty
  // state.
  if (locationId) {
    where.vehicle = { homeLocationId: locationId };
  }
  return where;
}

// ---------------------------------------------------------------------------
// Pure aggregation — exposed for unit testing
// ---------------------------------------------------------------------------

/**
 * Bucket prisma-shaped TollTransactions by vehicleId. Unmatched rows
 * (vehicleId === null) are returned separately so the page can highlight
 * reconciliation work.
 */
function aggregateByVehicle(transactions) {
  const byVehicle = new Map();
  const unmatched = { count: 0, amount: 0, transactions: [] };
  for (const t of transactions) {
    const amt = num(t.amount);
    if (!t.vehicleId) {
      unmatched.count += 1;
      unmatched.amount = moneyRound(unmatched.amount + amt);
      // Cap unmatched detail list at 50 rows to avoid huge payloads.
      if (unmatched.transactions.length < 50) {
        unmatched.transactions.push(formatTransaction(t));
      }
      continue;
    }
    if (!byVehicle.has(t.vehicleId)) {
      byVehicle.set(t.vehicleId, {
        vehicleId: t.vehicleId,
        plate: t.vehicle?.plate || null,
        label: t.vehicle ? [t.vehicle.year, t.vehicle.make, t.vehicle.model].filter(Boolean).join(' ') || null : null,
        vehicleType: t.vehicle?.vehicleType?.name || null,
        homeLocation: t.vehicle?.homeLocation?.name || null,
        count: 0,
        amount: 0,
        locations: new Map(), // toll plaza name → count
      });
    }
    const v = byVehicle.get(t.vehicleId);
    v.count += 1;
    v.amount = moneyRound(v.amount + amt);
    if (t.location) {
      v.locations.set(t.location, (v.locations.get(t.location) || 0) + 1);
    }
  }

  // Finalize: convert locations map to a top-3 list
  const vehicles = Array.from(byVehicle.values()).map((v) => {
    const top = Array.from(v.locations.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));
    delete v.locations;
    return { ...v, topLocations: top };
  });
  vehicles.sort((a, b) => b.amount - a.amount);
  return { vehicles, unmatched };
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

  // Load matched transactions (with vehicle details) — these power the per-vehicle table
  const matched = await prisma.tollTransaction.findMany({
    where: buildTransactionWhere({
      tenantId, locationId, gte: fromDate, lt: windowEnd, vehicleScope: 'matched',
    }),
    select: {
      id: true, vehicleId: true, amount: true, transactionAt: true, location: true,
      vehicle: {
        select: {
          plate: true, year: true, make: true, model: true,
          vehicleType: { select: { name: true } },
          homeLocation: { select: { name: true } },
        },
      },
    },
  });

  // Load unmatched transactions separately (location filter doesn't apply here)
  const unmatched = locationId
    ? [] // when a location filter is active, unmatched can't be attributed anywhere
    : await prisma.tollTransaction.findMany({
        where: buildTransactionWhere({
          tenantId, locationId: null, gte: fromDate, lt: windowEnd, vehicleScope: 'unmatched',
        }),
        select: {
          id: true, vehicleId: true, amount: true, transactionAt: true, location: true,
          lane: true, direction: true, plateRaw: true, tagRaw: true,
          status: true, needsReview: true, reservationId: true,
        },
      });

  const agg = aggregateByVehicle([...matched, ...unmatched]);

  const totalsAmount = moneyRound(
    agg.vehicles.reduce((acc, v) => acc + v.amount, 0) + agg.unmatched.amount
  );
  const totalsCount = agg.vehicles.reduce((acc, v) => acc + v.count, 0) + agg.unmatched.count;

  return {
    range: { from: fromDate.toISOString(), to: addDays(windowEnd, -1).toISOString() },
    rangeDays: safeNumDays,
    truncated,
    totals: {
      amount: totalsAmount,
      count: totalsCount,
      vehicleCount: agg.vehicles.length,
      unmatchedCount: agg.unmatched.count,
      unmatchedAmount: agg.unmatched.amount,
      averagePerVehicle: agg.vehicles.length > 0
        ? moneyRound(agg.vehicles.reduce((acc, v) => acc + v.amount, 0) / agg.vehicles.length)
        : 0,
    },
    vehicles: agg.vehicles,
    unmatched: agg.unmatched,
    filters: { locationId },
  };
}

// ---------------------------------------------------------------------------
// Drill-down — transactions for a vehicle (or unmatched)
// ---------------------------------------------------------------------------

async function transactionsDrillDownHandler(req, res, { tenantId }) {
  const prisma = await resolveDefaultPrisma();
  const vehicleId = req.query?.vehicleId ? String(req.query.vehicleId) : null;
  const unmatched = req.query?.unmatched === 'true' || req.query?.unmatched === '1';
  const locationId = req.query?.locationId ? String(req.query.locationId) : null;
  const from = req.query?.from ? new Date(req.query.from) : null;
  const to = req.query?.to ? new Date(req.query.to) : null;

  if (!vehicleId && !unmatched) {
    return res.status(400).json({ error: 'vehicleId or unmatched=true required' });
  }
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
  if (unmatched) where.vehicleId = null;
  else where.vehicleId = vehicleId;
  if (locationId && !unmatched) where.vehicle = { homeLocationId: locationId };

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

  const total = moneyRound(transactions.reduce((acc, t) => acc + num(t.amount), 0));

  return res.json({
    vehicleId: unmatched ? null : vehicleId,
    unmatched,
    locationId,
    totalAmount: total,
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
  const { totals, vehicles, unmatched, range } = data;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Total tolls</div><div class="strip-value">${money(totals.amount)}</div><div style="font-size:9px;color:#5F5E5A">${totals.count} transactions</div></div>
    <div class="strip-card"><div class="strip-label">Vehicles charged</div><div class="strip-value">${totals.vehicleCount}</div></div>
    <div class="strip-card"><div class="strip-label">Avg per vehicle</div><div class="strip-value">${money(totals.averagePerVehicle)}</div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Unmatched</div><div class="strip-value">${totals.unmatchedCount}</div><div style="font-size:9px;color:#412402">${money(totals.unmatchedAmount)}</div></div>
  </div>`;

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">${escapeHtml(range.from.slice(0,10))} → ${escapeHtml(range.to.slice(0,10))}</p>
    <h3>By vehicle</h3>
    <table style="font-size:10px"><thead><tr>
      <th style="text-align:left">Plate</th>
      <th style="text-align:left">Vehicle</th>
      <th class="num">Tolls</th>
      <th class="num">Total</th>
      <th style="text-align:left">Top plazas</th>
    </tr></thead><tbody>`;
  for (const v of vehicles) {
    const plazas = v.topLocations.map((p) => `${escapeHtml(p.name)} (${p.count})`).join(', ');
    body += `<tr>
      <td><strong>${escapeHtml(v.plate || '—')}</strong></td>
      <td>${escapeHtml(v.label || '—')}</td>
      <td class="num">${v.count}</td>
      <td class="num"><strong>${money(v.amount)}</strong></td>
      <td>${plazas || '—'}</td>
    </tr>`;
  }
  body += `</tbody></table>`;

  if (unmatched.count > 0) {
    body += `<h3 style="color:#791F1F">Unmatched · ${unmatched.count} · ${money(unmatched.amount)}</h3>
      <p style="font-size:10px;color:#5F5E5A">These tolls weren't tied to a vehicle. Likely candidates for manual reconciliation.</p>`;
  }
  if (vehicles.length === 0 && unmatched.count === 0) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No tolls in this window.</p>`;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { vehicles, unmatched, totals, range } = data;
  const title = 'Toll Report — per Vehicle';
  const subtitle = `${range.from.slice(0,10)} → ${range.to.slice(0,10)}`;

  return {
    title,
    subtitle,
    sheets: [
      {
        name: 'By vehicle',
        bannerRows: [[title], [subtitle]],
        columns: [
          { header: 'Plate',         key: 'plate',        width: 10 },
          { header: 'Vehicle',       key: 'label',        width: 22 },
          { header: 'Class',         key: 'vehicleType',  width: 14 },
          { header: 'Home location', key: 'homeLocation', width: 18 },
          { header: 'Tolls',         key: 'count',        width: 10, type: 'integer'  },
          { header: 'Total',         key: 'amount',       width: 12, type: 'currency' },
          { header: 'Top plazas',    key: 'topPlazas',    width: 36 },
        ],
        rows: vehicles.map((v) => ({
          plate: v.plate || '',
          label: v.label || '',
          vehicleType: v.vehicleType || '',
          homeLocation: v.homeLocation || '',
          count: v.count,
          amount: v.amount,
          topPlazas: v.topLocations.map((p) => `${p.name} (${p.count})`).join('; '),
        })),
        footerRow: {
          plate: 'TOTAL', label: '', vehicleType: '', homeLocation: '',
          count: vehicles.reduce((acc, v) => acc + v.count, 0),
          amount: moneyRound(vehicles.reduce((acc, v) => acc + v.amount, 0)),
          topPlazas: '',
        },
      },
      ...(unmatched.count > 0 ? [{
        name: 'Unmatched',
        bannerRows: [['Unmatched tolls'], [subtitle]],
        columns: [
          { header: 'Transaction',  key: 'transactionLabel', width: 18 },
          { header: 'Plate (raw)',  key: 'plateRaw',         width: 12 },
          { header: 'Tag (raw)',    key: 'tagRaw',           width: 12 },
          { header: 'Plaza',        key: 'location',         width: 22 },
          { header: 'Amount',       key: 'amount',           width: 12, type: 'currency' },
          { header: 'Needs review', key: 'needsReview',      width: 14 },
        ],
        rows: unmatched.transactions.map((t) => ({
          transactionLabel: t.transactionLabel,
          plateRaw: t.plateRaw,
          tagRaw: t.tagRaw,
          location: t.location || '',
          amount: t.amount,
          needsReview: t.needsReview ? 'Yes' : 'No',
        })),
        footerRow: {
          transactionLabel: 'TOTAL (top 50)',
          plateRaw: '', tagRaw: '', location: '',
          amount: moneyRound(unmatched.transactions.reduce((acc, t) => acc + num(t.amount), 0)),
          needsReview: '',
        },
      }] : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'toll-per-vehicle',
  title: 'Toll Report — per Vehicle',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/transactions', method: 'get', handler: transactionsDrillDownHandler },
  ],
});

export const _tollPerVehicleInternal = {
  computeData,
  transactionsDrillDownHandler,
  aggregateByVehicle,
  formatTransaction,
  MAX_DAYS,
};
