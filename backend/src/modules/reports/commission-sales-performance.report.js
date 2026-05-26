/**
 * Commission & Sales Performance Report — Round 31a (2026-05-26).
 *
 * Single-period report: per-clerk metrics, sales attach % by service, and
 * counter revenue per service. Matches the April 2026 Commission Report
 * PDF that Hector hand-built before this lived in RFM.
 *
 * Data flow:
 *   1. Find RentalAgreement rows where finalizedAt OR closedAt ∈ [from, to]
 *      (status is irrelevant — we count any rental that hit the counter in
 *      the window)
 *   2. Group by **commission earner** — i.e. the AgreementCommission's
 *      employeeUserId, which is the person who performed CHECKOUT (per
 *      rental-agreements.service.js#syncAgreementCommissionSnapshot).
 *      When an agreement has no commission record yet (not closed, sync
 *      didn't run), fall back to salesOwnerUserId so the rental still
 *      appears with $0 commission and someone is credited for the activity.
 *   3. For each clerk: count rentals, sum rental days, sum paid-at-counter,
 *      sum commissions earned (commissionAmount from the snapshot row)
 *   4. For each service code in our SERVICE_CATALOG, count how many of the
 *      clerk's agreements had a selected charge whose code/name matched,
 *      and sum the $ amounts for those charges
 *
 * Service matching is by `code` first (when present) then a fuzzy match
 * on `name`. This handles both the iPOS Transact CSV import flow and the
 * native RFM line items.
 *
 * Round-31a bug fix (2026-05-26): previously the loop filtered
 *   `cm.employeeUserId === clerkId` where clerkId was the salesOwnerUserId,
 * so when the sales owner and checkout actor were different people the
 * commission was dropped and every clerk row showed $0. Now we pivot by
 * the commission earner directly.
 */

import { registerReport } from './reports-v2.routes.js';

const SERVICE_CATALOG = [
  { slug: 'TOLLS',             label: 'Tolls',             codes: ['TOLLS', 'TOLL'],                  namePatterns: [/tolls?/i],             commPerSale: 1, benchmark: '85%+' },
  { slug: 'TIRE_GLASS',        label: 'Tire & Glass',      codes: ['TIRE_GLASS', 'TG'],               namePatterns: [/tire.*glass/i],        commPerSale: 1, benchmark: '60%+' },
  { slug: 'ROADSIDE',          label: 'Roadside',          codes: ['ROADSIDE', 'RS'],                 namePatterns: [/roadside/i],           commPerSale: 1, benchmark: '60%+' },
  { slug: 'LIABILITY',         label: 'Liability',         codes: ['LIABILITY', 'LIAB'],              namePatterns: [/liab/i],               commPerSale: 2, benchmark: '55%+' },
  { slug: 'INSURANCE',         label: 'Insurance',         codes: ['INSURANCE', 'INS'],               namePatterns: [/insurance/i],          commPerSale: 3, benchmark: '45–55%' },
  { slug: 'ADDITIONAL_DRIVER', label: 'Additional Driver', codes: ['ADDITIONAL_DRIVER', 'ADD_DRIVER'],namePatterns: [/additional.*driver/i, /add.*driver/i], commPerSale: 1, benchmark: 'demand-led' },
  { slug: 'CAR_SEAT',          label: 'Car Seat',          codes: ['CAR_SEAT', 'CARSEAT'],            namePatterns: [/car.*seat/i],          commPerSale: 1, benchmark: 'demand-led' },
  { slug: 'PRE_PAID_GAS',      label: 'Pre-Paid Gas',      codes: ['PRE_PAID_GAS', 'GAS_PREPAY'],     namePatterns: [/pre.?paid.*gas/i, /gas.*pre.?paid/i], commPerSale: 1, benchmark: '15%+' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchesService(charge, service) {
  if (charge.code && service.codes.includes(String(charge.code).toUpperCase())) return true;
  const name = String(charge.name || '');
  return service.namePatterns.some((re) => re.test(name));
}

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

  const agreements = await prisma.rentalAgreement.findMany({
    where: {
      tenantId,
      OR: [
        { finalizedAt: { gte: fromDate, lte: toDate } },
        { closedAt:    { gte: fromDate, lte: toDate } },
      ],
    },
    select: {
      id: true,
      pickupAt: true,
      returnAt: true,
      salesOwnerUserId: true,
      salesOwnerUser: { select: { id: true, fullName: true } },
      charges: { select: { code: true, name: true, total: true, selected: true } },
      payments: { select: { amount: true, method: true } },
      commissions: {
        select: {
          employeeUserId: true,
          commissionAmount: true,
          employeeUser: { select: { id: true, fullName: true } },
        },
      },
    },
  });

  // Group by **commission earner** (the checkout actor). When an agreement has
  // no commission record (e.g. not yet closed, snapshot sync hasn't run),
  // fall back to salesOwnerUserId so the activity is still attributed somewhere
  // — those rows show $0 commission until the snapshot is written.
  const byClerk = new Map();
  for (const ag of agreements) {
    // Per the unique constraint on AgreementCommission(rentalAgreementId,
    // employeeUserId), and the deleteMany() in syncAgreementCommissionSnapshot,
    // there is at most ONE commission row per agreement in steady state.
    const primaryCommission = (ag.commissions || [])[0] || null;
    const clerkId =
      primaryCommission?.employeeUserId ||
      ag.salesOwnerUserId ||
      '__unassigned__';
    const clerkName =
      primaryCommission?.employeeUser?.fullName ||
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
    // Sum every commission on the agreement (typically just the one). They all
    // belong to this clerk now because we keyed the bucket by employeeUserId.
    for (const cm of (ag.commissions || [])) {
      c.commissions += num(cm.commissionAmount);
    }
    // Service attach (one rental can only contribute 1 to a service's count)
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
