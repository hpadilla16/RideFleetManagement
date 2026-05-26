/**
 * Commission & Sales Performance Report — Round 31b (2026-05-26).
 *
 * Single-period report: per-clerk metrics, sales attach % by service, and
 * counter revenue per service. Matches the April 2026 Commission Report
 * PDF that Hector hand-built before this lived in RFM.
 *
 * Data flow:
 *   1. Find RentalAgreement rows where finalizedAt OR closedAt ∈ [from, to]
 *      (status is irrelevant — we count any rental that hit the counter in
 *      the window).
 *   2. Group by **checkout actor** — read from the agreement's CHECKOUT
 *      inspection (`inspections.actorUserId` where phase=CHECKOUT), with
 *      fallback to salesOwnerUserId when no inspection exists. This mirrors
 *      the attribution rule in syncAgreementCommissionSnapshot.
 *   3. For each clerk: count rentals, sum rental days, sum paid-at-counter.
 *   4. For each service in SERVICE_CATALOG, count agreements where the
 *      service was attached (one rental contributes at most 1 to a service's
 *      attach count) and sum the $ from those charges.
 *   5. **Commission** is computed inline from the attach: each attached
 *      service contributes `commPerSale` ($1, $2, or $3 depending on
 *      service) to that rental's commission. The clerk's total commission =
 *      sum of (attached service × commPerSale) across all their rentals.
 *      This deliberately does NOT use AgreementCommission.commissionAmount
 *      — that path requires per-employee CommissionPlans to be configured
 *      in settings, and the report is meant to be self-contained against
 *      the SERVICE_CATALOG rates that mirror Hector's hand-built PDF.
 *
 * Service matching is by `code` first (when present) then a fuzzy match on
 * `name`. This handles both the iPOS Transact CSV import flow and the
 * native RFM line items.
 *
 * Round-31b (2026-05-26): commission is now computed inline from
 *   attach × commPerSale instead of summing AgreementCommission.commissionAmount
 *   (which was $0 for any employee without a configured CommissionPlan, so
 *   only Valeria had a non-zero figure in production).
 * Round-31a (2026-05-26): pivoted bucketing from salesOwnerUserId to
 *   the checkout actor.
 */

import { registerReport } from './reports-v2.routes.js';
import { SERVICE_CATALOG, matchesService } from '../../lib/commission-catalog.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function daysBetween(a, b) {
  if (!a || !b) return 0;
  const ms = new Date(b) - new Date(a);
  return Math.max(0, Math.round(ms / (24 * 60 * 60 * 1000)));
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

async function computeData({ tenantId, from, to }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();

  // Filter by **CHECKOUT inspection date**. Commission is earned when the
  // car is released, not when the agreement was finalized or closed. The
  // some(phase=CHECKOUT, capturedAt in window) predicate scopes the rentals
  // to those whose checkout actually happened in [from, to], regardless of
  // current agreement status (FINALIZED, CHECKED_OUT, CHECKED_IN, CLOSED).
  const agreements = await prisma.rentalAgreement.findMany({
    where: {
      tenantId,
      inspections: {
        some: {
          phase: 'CHECKOUT',
          capturedAt: { gte: fromDate, lte: toDate },
          actorUserId: { not: null },
        },
      },
    },
    select: {
      id: true,
      pickupAt: true,
      returnAt: true,
      salesOwnerUserId: true,
      salesOwnerUser: { select: { id: true, fullName: true } },
      charges: { select: { code: true, name: true, total: true, selected: true } },
      payments: { select: { amount: true, method: true } },
      inspections: {
        where: { phase: 'CHECKOUT' },
        orderBy: [{ capturedAt: 'desc' }, { updatedAt: 'desc' }],
        select: { actorUserId: true, capturedAt: true },
      },
    },
  });

  // Resolve checkout-actor names with a single User lookup. We seed the map
  // with the salesOwners we already have, then add any actor IDs not already
  // covered. This is a tight set (≤ headcount of the shop), so one query is
  // fine and avoids N+1 work.
  const userNamesById = new Map();
  for (const ag of agreements) {
    if (ag.salesOwnerUserId && ag.salesOwnerUser?.fullName) {
      userNamesById.set(ag.salesOwnerUserId, ag.salesOwnerUser.fullName);
    }
  }
  const actorIds = new Set();
  for (const ag of agreements) {
    for (const ins of (ag.inspections || [])) {
      if (ins?.actorUserId && !userNamesById.has(ins.actorUserId)) {
        actorIds.add(ins.actorUserId);
      }
    }
  }
  if (actorIds.size > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: Array.from(actorIds) } },
      select: { id: true, fullName: true },
    });
    for (const u of users) userNamesById.set(u.id, u.fullName);
  }

  // Group by **checkout actor**. The CHECKOUT inspection's actorUserId is who
  // physically released the car and is the canonical commission earner per
  // rental-agreements.service.js. Fall back to salesOwnerUserId when no
  // inspection exists (rare — agreement closed without a CHECKOUT inspection).
  const byClerk = new Map();
  for (const ag of agreements) {
    const checkoutInspection = (ag.inspections || []).find((row) => row?.actorUserId) || null;
    const clerkId =
      checkoutInspection?.actorUserId ||
      ag.salesOwnerUserId ||
      '__unassigned__';
    const clerkName =
      userNamesById.get(clerkId) ||
      ag.salesOwnerUser?.fullName ||
      'Unassigned';

    if (!byClerk.has(clerkId)) {
      byClerk.set(clerkId, {
        id: clerkId,
        name: clerkName,
        rentals: 0,
        totalDays: 0,
        paidAtCounter: 0,
        commissions: 0,
        serviceCounts: Object.fromEntries(SERVICE_CATALOG.map((s) => [s.slug, 0])),
        serviceDollars: Object.fromEntries(SERVICE_CATALOG.map((s) => [s.slug, 0])),
      });
    }
    const c = byClerk.get(clerkId);
    c.rentals += 1;
    c.totalDays += daysBetween(ag.pickupAt, ag.returnAt);
    for (const p of (ag.payments || [])) {
      c.paidAtCounter += num(p.amount);
    }
    // Service attach + commission roll-up. Each attached service contributes
    // commPerSale to the clerk's commission, independent of CommissionPlan
    // setup. Mirrors the rates Hector used in the April 2026 hand-built PDF.
    for (const service of SERVICE_CATALOG) {
      let matched = false;
      let serviceDollarsThisAg = 0;
      for (const ch of (ag.charges || [])) {
        if (ch.selected === false) continue;
        if (matchesService(ch, service)) {
          matched = true;
          serviceDollarsThisAg += num(ch.total);
        }
      }
      if (matched) {
        c.serviceCounts[service.slug] += 1;
        c.serviceDollars[service.slug] += serviceDollarsThisAg;
        c.commissions += num(service.commPerSale);
      }
    }
  }

  const clerks = Array.from(byClerk.values()).sort((a, b) => b.paidAtCounter - a.paidAtCounter);

  // Team totals
  const team = {
    rentals: clerks.reduce((acc, c) => acc + c.rentals, 0),
    totalDays: clerks.reduce((acc, c) => acc + c.totalDays, 0),
    paidAtCounter: clerks.reduce((acc, c) => acc + c.paidAtCounter, 0),
    commissions: clerks.reduce((acc, c) => acc + c.commissions, 0),
    serviceCounts: Object.fromEntries(SERVICE_CATALOG.map((s) => [s.slug,
      clerks.reduce((acc, c) => acc + (c.serviceCounts[s.slug] || 0), 0)])),
    serviceDollars: Object.fromEntries(SERVICE_CATALOG.map((s) => [s.slug,
      clerks.reduce((acc, c) => acc + (c.serviceDollars[s.slug] || 0), 0)])),
  };

  // Derived fields (kept out of the per-clerk loop so the math reads cleanly)
  function avgDays(c) { return c.rentals > 0 ? c.totalDays / c.rentals : 0; }
  function avgPaid(c) { return c.rentals > 0 ? c.paidAtCounter / c.rentals : 0; }
  function commPer(c) { return c.rentals > 0 ? c.commissions / c.rentals : 0; }
  function shareOf(numerator, denom) { return denom > 0 ? numerator / denom : 0; }
  function attachPct(count, rentals) { return rentals > 0 ? count / rentals : 0; }

  const clerksOut = clerks.map((c) => ({
    id: c.id,
    name: c.name,
    rentals: c.rentals,
    totalDays: c.totalDays,
    avgDays: avgDays(c),
    paidAtCounter: c.paidAtCounter,
    avgPaid: avgPaid(c),
    commissions: c.commissions,
    commissionPerRental: commPer(c),
    shareRentals: shareOf(c.rentals, team.rentals),
    shareRevenue: shareOf(c.paidAtCounter, team.paidAtCounter),
    shareCommissions: shareOf(c.commissions, team.commissions),
    attach: Object.fromEntries(SERVICE_CATALOG.map((s) => [s.slug,
      attachPct(c.serviceCounts[s.slug], c.rentals)])),
    serviceDollars: c.serviceDollars,
  }));

  const teamOut = {
    rentals: team.rentals,
    totalDays: team.totalDays,
    avgDays: team.rentals > 0 ? team.totalDays / team.rentals : 0,
    paidAtCounter: team.paidAtCounter,
    avgPaid: team.rentals > 0 ? team.paidAtCounter / team.rentals : 0,
    commissions: team.commissions,
    commissionPerRental: team.rentals > 0 ? team.commissions / team.rentals : 0,
    attach: Object.fromEntries(SERVICE_CATALOG.map((s) => [s.slug,
      attachPct(team.serviceCounts[s.slug], team.rentals)])),
    serviceDollars: team.serviceDollars,
    serviceCounts: team.serviceCounts,
  };

  return {
    range: { from: fromDate.toISOString(), to: toDate.toISOString() },
    services: SERVICE_CATALOG.map((s) => ({
      slug: s.slug, label: s.label, commPerSale: s.commPerSale, benchmark: s.benchmark,
    })),
    clerks: clerksOut,
    team: teamOut,
  };
}

// ---------------------------------------------------------------------------
// renderHtml — used for PDF export
// ---------------------------------------------------------------------------

function pct(v) { return `${(num(v) * 100).toFixed(0)}%`; }
function money(v) { return `$${num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function int(v) { return num(v).toLocaleString(); }

function heatClass(attachFrac) {
  const p = num(attachFrac);
  if (p >= 0.6) return 'heat-green';
  if (p >= 0.3) return 'heat-amber';
  return 'heat-red';
}

function renderHtml(data) {
  const { clerks, team, services } = data;

  let metricsHtml = `<h3>Per-clerk metrics</h3>
  <table><thead><tr><th>Metric</th>${clerks.map((c) => `<th class="num">${escapeHtml(c.name)}</th>`).join('')}<th class="num">Team</th></tr></thead><tbody>`;
  const rows = [
    ['Rentals closed', clerks.map((c) => int(c.rentals)),                int(team.rentals)],
    ['Total rental days', clerks.map((c) => int(c.totalDays)),            int(team.totalDays)],
    ['Avg days / rental', clerks.map((c) => c.avgDays.toFixed(2)),        team.avgDays.toFixed(2)],
    ['Paid at counter ($)', clerks.map((c) => money(c.paidAtCounter)),    money(team.paidAtCounter)],
    ['Avg $ per rental', clerks.map((c) => money(c.avgPaid)),             money(team.avgPaid)],
    ['Commissions earned ($)', clerks.map((c) => money(c.commissions)),   money(team.commissions)],
    ['Commission $ / rental', clerks.map((c) => money(c.commissionPerRental)), money(team.commissionPerRental)],
    ['% Share of rentals', clerks.map((c) => pct(c.shareRentals)),        '100%'],
    ['% Share of revenue', clerks.map((c) => pct(c.shareRevenue)),        '100%'],
  ];
  for (const [label, cells, total] of rows) {
    metricsHtml += `<tr><td>${escapeHtml(label)}</td>${cells.map((v) => `<td class="num">${v}</td>`).join('')}<td class="num"><strong>${total}</strong></td></tr>`;
  }
  metricsHtml += `</tbody></table>`;

  let attachHtml = `<h3>Sales attach % by service</h3>
  <table><thead><tr><th>Service</th><th class="num">$/Sale</th>${clerks.map((c) => `<th class="num">${escapeHtml(c.name)}</th>`).join('')}<th class="num">Team</th><th class="num">Benchmark</th></tr></thead><tbody>`;
  for (const service of services) {
    attachHtml += `<tr><td>${escapeHtml(service.label)}</td><td class="num">$${service.commPerSale}</td>`;
    for (const c of clerks) {
      const v = c.attach[service.slug];
      attachHtml += `<td class="num ${heatClass(v)}">${pct(v)}</td>`;
    }
    const teamV = team.attach[service.slug];
    attachHtml += `<td class="num ${heatClass(teamV)}"><strong>${pct(teamV)}</strong></td>`;
    attachHtml += `<td class="num">${escapeHtml(service.benchmark)}</td></tr>`;
  }
  attachHtml += `</tbody></table>`;

  // Counter $ per service
  let dollarsHtml = `<h3>Counter $ generated per service (team)</h3>
  <table><thead><tr><th>Service</th><th class="num">Counter $</th><th class="num">Sales (count)</th><th class="num">Avg $/Sale</th></tr></thead><tbody>`;
  let total$ = 0, totalSales = 0;
  for (const service of services) {
    const dollars = num(team.serviceDollars[service.slug]);
    const count = num(team.serviceCounts[service.slug]);
    const avg = count > 0 ? dollars / count : 0;
    total$ += dollars;
    totalSales += count;
    dollarsHtml += `<tr><td>${escapeHtml(service.label)}</td><td class="num">${money(dollars)}</td><td class="num">${int(count)}</td><td class="num">${money(avg)}</td></tr>`;
  }
  dollarsHtml += `<tr><td><strong>TOTAL</strong></td><td class="num"><strong>${money(total$)}</strong></td><td class="num"><strong>${int(totalSales)}</strong></td><td class="num"><strong>${money(totalSales > 0 ? total$ / totalSales : 0)}</strong></td></tr>`;
  dollarsHtml += `</tbody></table>`;

  // Snapshot strip at the top
  const stripHtml = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Rentals closed</div><div class="strip-value">${int(team.rentals)}</div></div>
    <div class="strip-card"><div class="strip-label">Counter revenue</div><div class="strip-value">${money(team.paidAtCounter)}</div></div>
    <div class="strip-card"><div class="strip-label">Commissions</div><div class="strip-value">${money(team.commissions)}</div></div>
    <div class="strip-card"><div class="strip-label">Avg $/rental</div><div class="strip-value">${money(team.avgPaid)}</div></div>
  </div>`;

  return `${stripHtml}${metricsHtml}${attachHtml}${dollarsHtml}`;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// buildExcelSpec — used for Excel export
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { clerks, team, services, range } = data;
  const title = 'Commission & Sales Performance Report';
  const subtitle = `${range.from.slice(0, 10)} → ${range.to.slice(0, 10)}`;

  // Per-clerk metrics sheet (one row per clerk)
  const metricsRows = clerks.map((c) => ({
    clerk: c.name,
    rentals: c.rentals,
    totalDays: c.totalDays,
    avgDays: Number(c.avgDays.toFixed(2)),
    paidAtCounter: c.paidAtCounter,
    avgPaid: c.avgPaid,
    commissions: c.commissions,
    commPerRental: c.commissionPerRental,
    shareRentals: c.shareRentals,
    shareRevenue: c.shareRevenue,
  }));
  metricsRows.push({
    clerk: 'TEAM TOTAL',
    rentals: team.rentals,
    totalDays: team.totalDays,
    avgDays: Number(team.avgDays.toFixed(2)),
    paidAtCounter: team.paidAtCounter,
    avgPaid: team.avgPaid,
    commissions: team.commissions,
    commPerRental: team.commissionPerRental,
    shareRentals: 1,
    shareRevenue: 1,
  });

  // Attach % sheet
  const attachRows = services.map((s) => {
    const row = { service: s.label, comm: `$${s.commPerSale}`, benchmark: s.benchmark };
    for (const c of clerks) row[`attach_${c.id}`] = c.attach[s.slug];
    row.team = team.attach[s.slug];
    return row;
  });

  const attachColumns = [
    { header: 'Service',   key: 'service',  width: 22 },
    { header: '$/Sale',    key: 'comm',     width: 10 },
    ...clerks.map((c) => ({ header: c.name, key: `attach_${c.id}`, width: 12, type: 'percent' })),
    { header: 'Team',      key: 'team',     width: 12, type: 'percent' },
    { header: 'Benchmark', key: 'benchmark', width: 14 },
  ];

  return {
    title,
    subtitle,
    sheets: [
      {
        name: 'Per-clerk metrics',
        bannerRows: [[title], [subtitle]],
        columns: [
          { header: 'Clerk',         key: 'clerk',         width: 22 },
          { header: 'Rentals',       key: 'rentals',       width: 10, type: 'integer' },
          { header: 'Total days',    key: 'totalDays',     width: 12, type: 'integer' },
          { header: 'Avg days',      key: 'avgDays',       width: 11 },
          { header: 'Paid counter',  key: 'paidAtCounter', width: 14, type: 'currency' },
          { header: 'Avg $ rental',  key: 'avgPaid',       width: 13, type: 'currency' },
          { header: 'Commissions',   key: 'commissions',   width: 13, type: 'currency' },
          { header: '$/Rental',      key: 'commPerRental', width: 11, type: 'currency' },
          { header: '% Rentals',     key: 'shareRentals',  width: 11, type: 'percent' },
          { header: '% Revenue',     key: 'shareRevenue',  width: 11, type: 'percent' },
        ],
        rows: metricsRows,
      },
      {
        name: 'Attach % by service',
        bannerRows: [[`${title} — Attach %`], [subtitle]],
        columns: attachColumns,
        rows: attachRows,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

registerReport({
  slug: 'commission-sales-performance',
  title: 'Commission & Sales Performance Report',
  computeData,
  renderHtml,
  buildExcelSpec,
});

export const _commissionInternal = { computeData, SERVICE_CATALOG, matchesService };
