/**
 * Rental Agent Track Record (month-over-month) — Round 24c (2026-05-22).
 *
 * Multi-month performance report. Mirrors the OTC Tracking Master PDF that
 * Hector built by hand for Dec 2025 → April 2026.
 *
 * Sections:
 *   1. Monthly snapshot — one row per calendar month in the range, team totals
 *   2. Per-clerk track records — one block per clerk, same monthly rollup
 *   3. Attach % heatmap — service × month, with Δ column from first → last month
 *
 * Date range is user-controlled. Buckets bucket-by-bucket on the agreement's
 * `finalizedAt OR closedAt` date.
 */

import { registerReport } from './reports-v2.routes.js';
import { DEFAULT_TENANT_TIMEZONE } from '../../lib/date-utils.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';

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

function matchesService(charge, service) {
  if (charge.code && service.codes.includes(String(charge.code).toUpperCase())) return true;
  const name = String(charge.name || '');
  return service.namePatterns.some((re) => re.test(name));
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((new Date(b) - new Date(a)) / (24 * 60 * 60 * 1000)));
}

// 2026-05-26: tz-aware month bucketing. Server-local getMonth() / new
// Date(y, m, 1) shifted late-evening events into the next UTC month, so a
// PR Jan 31 11 PM rental was getting bucketed under February. Now anchored
// in tenant TZ via Intl. tz defaults to PR for legacy callers; computeData
// passes the resolved tenant timezone.
function monthKey(d, tz = DEFAULT_TENANT_TIMEZONE) {
  const dt = d instanceof Date ? d : new Date(d);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit'
  }).formatToParts(dt).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(m) - 1]} ${y}`;
}

function rangeMonths(from, to, tz = DEFAULT_TENANT_TIMEZONE) {
  const out = [];
  // Walk monthKey strings rather than Date objects so the iteration is
  // anchored in tenant TZ end-to-end. Limited to 24 iterations defensively.
  const startKey = monthKey(from, tz);
  const endKey = monthKey(to, tz);
  let cur = startKey;
  let safety = 0;
  while (cur <= endKey && safety++ < 24) {
    out.push(cur);
    // Increment month: parse, +1, wrap to next year.
    const [y, m] = cur.split('-').map(Number);
    const nextMonth = m === 12 ? 1 : m + 1;
    const nextYear = m === 12 ? y + 1 : y;
    cur = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
  }
  return out;
}

// ---------------------------------------------------------------------------

let _defaultPrisma = null;
async function resolveDefaultPrisma() {
  if (_defaultPrisma) return _defaultPrisma;
  const mod = await import('../../lib/prisma.js');
  _defaultPrisma = mod.prisma;
  return _defaultPrisma;
}

function emptyBucket() {
  return {
    rentals: 0,
    totalDays: 0,
    paidAtCounter: 0,
    commissions: 0,
    serviceCounts: Object.fromEntries(SERVICE_CATALOG.map((s) => [s.slug, 0])),
    serviceDollars: Object.fromEntries(SERVICE_CATALOG.map((s) => [s.slug, 0])),
  };
}

async function computeData({ tenantId, from, to }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const tenantTz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));

  // Default: last 5 calendar months ending today
  const toDate = to ? new Date(to) : new Date();
  let fromDate;
  if (from) {
    fromDate = new Date(from);
  } else {
    fromDate = new Date(toDate.getFullYear(), toDate.getMonth() - 4, 1);
  }

  const months = rangeMonths(fromDate, toDate, tenantTz);

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
      finalizedAt: true,
      closedAt: true,
      salesOwnerUserId: true,
      salesOwnerUser: { select: { id: true, fullName: true } },
      charges: { select: { code: true, name: true, total: true, selected: true } },
      payments: { select: { amount: true } },
      // CHECKOUT inspections drive clerk attribution — the actor who released
      // the car is the commission earner (mirror of syncAgreementCommissionSnapshot).
      // RentalAgreementInspection has no User relation in the schema, so we
      // resolve names with a separate User query below.
      inspections: {
        where: { phase: 'CHECKOUT' },
        orderBy: [{ capturedAt: 'desc' }, { updatedAt: 'desc' }],
        select: { actorUserId: true },
      },
    },
  });

  // Resolve checkout-actor names with a single User lookup.
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

  // teamByMonth: monthKey → bucket
  const teamByMonth = new Map(months.map((m) => [m, emptyBucket()]));
  // clerks: clerkId → { id, name, byMonth: Map<monthKey, bucket> }
  // Bucketed by the **checkout actor** (whoever performed the CHECKOUT
  // inspection on the agreement), with fallback to salesOwnerUserId when
  // no inspection record exists. Commission is computed inline from
  // attach × commPerSale — see commission-sales-performance.report.js for
  // the rationale (CommissionPlan setup is not required).
  const clerks = new Map();

  for (const ag of agreements) {
    const bucketDate = ag.finalizedAt || ag.closedAt;
    if (!bucketDate) continue;
    const mk = monthKey(bucketDate, tenantTz);
    if (!teamByMonth.has(mk)) continue; // shouldn't happen with the where clause, but guard anyway

    const checkoutInspection = (ag.inspections || []).find((row) => row?.actorUserId) || null;
    const clerkId =
      checkoutInspection?.actorUserId ||
      ag.salesOwnerUserId ||
      '__unassigned__';
    const clerkName =
      userNamesById.get(clerkId) ||
      ag.salesOwnerUser?.fullName ||
      'Unassigned';
    if (!clerks.has(clerkId)) {
      clerks.set(clerkId, {
        id: clerkId,
        name: clerkName,
        byMonth: new Map(months.map((m) => [m, emptyBucket()])),
      });
    }

    const tb = teamByMonth.get(mk);
    const cb = clerks.get(clerkId).byMonth.get(mk);

    const days = daysBetween(ag.pickupAt, ag.returnAt);
    const paid = (ag.payments || []).reduce((acc, p) => acc + num(p.amount), 0);
    // Per-rental aggregate updates. Commission accrues inside the service
    // loop below (attach × commPerSale), so we add 0 here and let the
    // service-attach branch increment it.
    tb.rentals += 1; tb.totalDays += days; tb.paidAtCounter += paid;
    cb.rentals += 1; cb.totalDays += days; cb.paidAtCounter += paid;

    for (const service of SERVICE_CATALOG) {
      let matched = false;
      let dollarsThisAg = 0;
      for (const ch of (ag.charges || [])) {
        if (ch.selected === false) continue;
        if (matchesService(ch, service)) {
          matched = true;
          dollarsThisAg += num(ch.total);
        }
      }
      if (matched) {
        tb.serviceCounts[service.slug] += 1;
        tb.serviceDollars[service.slug] += dollarsThisAg;
        tb.commissions += num(service.commPerSale);
        cb.serviceCounts[service.slug] += 1;
        cb.serviceDollars[service.slug] += dollarsThisAg;
        cb.commissions += num(service.commPerSale);
      }
    }
  }

  // Build output
  const safeAvg = (n, d) => (d > 0 ? n / d : 0);

  const teamMonthly = months.map((m) => {
    const b = teamByMonth.get(m);
    return {
      month: m,
      monthLabel: monthLabel(m),
      rentals: b.rentals,
      totalDays: b.totalDays,
      counterDollars: b.paidAtCounter,
      avgDollarsPerRental: safeAvg(b.paidAtCounter, b.rentals),
      commissions: b.commissions,
      commissionPerRental: safeAvg(b.commissions, b.rentals),
    };
  });
  const teamTotal = months.reduce(
    (acc, m) => {
      const b = teamByMonth.get(m);
      acc.rentals += b.rentals;
      acc.totalDays += b.totalDays;
      acc.counterDollars += b.paidAtCounter;
      acc.commissions += b.commissions;
      return acc;
    },
    { rentals: 0, totalDays: 0, counterDollars: 0, commissions: 0 },
  );
  teamTotal.avgDollarsPerRental = safeAvg(teamTotal.counterDollars, teamTotal.rentals);
  teamTotal.commissionPerRental = safeAvg(teamTotal.commissions, teamTotal.rentals);

  // Per-clerk track record
  const clerksOut = Array.from(clerks.values()).map((cl) => {
    const monthly = months.map((m) => {
      const b = cl.byMonth.get(m);
      const teamBucket = teamByMonth.get(m);
      return {
        month: m,
        monthLabel: monthLabel(m),
        rentals: b.rentals,
        totalDays: b.totalDays,
        counterDollars: b.paidAtCounter,
        avgDollarsPerRental: safeAvg(b.paidAtCounter, b.rentals),
        commissions: b.commissions,
        commissionPerRental: safeAvg(b.commissions, b.rentals),
        shareOfTeamRentals: teamBucket.rentals > 0 ? b.rentals / teamBucket.rentals : 0,
      };
    });
    const total = monthly.reduce(
      (acc, m) => {
        acc.rentals += m.rentals;
        acc.totalDays += m.totalDays;
        acc.counterDollars += m.counterDollars;
        acc.commissions += m.commissions;
        return acc;
      },
      { rentals: 0, totalDays: 0, counterDollars: 0, commissions: 0 },
    );
    total.avgDollarsPerRental = safeAvg(total.counterDollars, total.rentals);
    total.commissionPerRental = safeAvg(total.commissions, total.rentals);
    total.shareOfTeamRentals = teamTotal.rentals > 0 ? total.rentals / teamTotal.rentals : 0;
    return { id: cl.id, name: cl.name, monthly, total };
  }).sort((a, b) => b.total.counterDollars - a.total.counterDollars);

  // Attach % heatmap — team & per-clerk
  function attachRow(byMonth) {
    return SERVICE_CATALOG.map((s) => {
      const cells = months.map((m) => {
        const b = byMonth.get(m);
        return b.rentals > 0 ? b.serviceCounts[s.slug] / b.rentals : 0;
      });
      const first = cells[0] ?? 0;
      const last = cells[cells.length - 1] ?? 0;
      return {
        slug: s.slug, label: s.label, commPerSale: s.commPerSale, benchmark: s.benchmark,
        byMonth: cells,
        delta: last - first,
      };
    });
  }
  const teamAttach = attachRow(teamByMonth);
  const clerkAttach = clerksOut.map((cl) => ({
    clerkId: cl.id,
    clerkName: cl.name,
    rows: attachRow(clerks.get(cl.id).byMonth),
  }));

  return {
    range: { from: fromDate.toISOString(), to: toDate.toISOString() },
    tenantTimeZone: tenantTz,
    months,
    monthLabels: months.map(monthLabel),
    services: SERVICE_CATALOG.map((s) => ({ slug: s.slug, label: s.label, commPerSale: s.commPerSale, benchmark: s.benchmark })),
    teamMonthly,
    teamTotal,
    clerks: clerksOut,
    teamAttach,
    clerkAttach,
  };
}

// ---------------------------------------------------------------------------

function pct(v) { return `${(num(v) * 100).toFixed(0)}%`; }
function money(v) { return `$${num(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }
function int(v) { return num(v).toLocaleString(); }

function heatClass(p) {
  const n = num(p);
  if (n >= 0.6) return 'heat-green';
  if (n >= 0.3) return 'heat-amber';
  return 'heat-red';
}

function deltaSpan(d) {
  const n = num(d);
  const sign = n > 0 ? '+' : '';
  const color = n < 0 ? '#A32D2D' : (n > 0 ? '#173404' : '#5F5E5A');
  return `<span style="color: ${color}">${sign}${(n * 100).toFixed(0)}%</span>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderHtml(data) {
  const { teamMonthly, teamTotal, clerks, teamAttach, monthLabels, months } = data;

  let html = `<h3>Monthly snapshot — team</h3>
  <table><thead><tr>
    <th>Month</th>
    <th class="num">Rentals</th>
    <th class="num">Days</th>
    <th class="num">Counter $</th>
    <th class="num">Avg $/Rental</th>
    <th class="num">Commissions</th>
    <th class="num">Comm $/Rental</th>
  </tr></thead><tbody>`;
  for (const m of teamMonthly) {
    html += `<tr><td>${escapeHtml(m.monthLabel)}</td>
      <td class="num">${int(m.rentals)}</td>
      <td class="num">${int(m.totalDays)}</td>
      <td class="num">${money(m.counterDollars)}</td>
      <td class="num">${money(m.avgDollarsPerRental)}</td>
      <td class="num">${money(m.commissions)}</td>
      <td class="num">${money(m.commissionPerRental)}</td>
    </tr>`;
  }
  html += `<tr style="background:#f1efe8"><td><strong>Total</strong></td>
    <td class="num"><strong>${int(teamTotal.rentals)}</strong></td>
    <td class="num"><strong>${int(teamTotal.totalDays)}</strong></td>
    <td class="num"><strong>${money(teamTotal.counterDollars)}</strong></td>
    <td class="num"><strong>${money(teamTotal.avgDollarsPerRental)}</strong></td>
    <td class="num"><strong>${money(teamTotal.commissions)}</strong></td>
    <td class="num"><strong>${money(teamTotal.commissionPerRental)}</strong></td>
  </tr></tbody></table>`;

  // Per-clerk track records
  for (const cl of clerks) {
    html += `<h3>${escapeHtml(cl.name)} — track record</h3>
    <table><thead><tr>
      <th>Month</th><th class="num">Rentals</th><th class="num">Counter $</th>
      <th class="num">Commissions</th><th class="num">% Team rentals</th>
    </tr></thead><tbody>`;
    for (const m of cl.monthly) {
      html += `<tr><td>${escapeHtml(m.monthLabel)}</td>
        <td class="num">${int(m.rentals)}</td>
        <td class="num">${money(m.counterDollars)}</td>
        <td class="num">${money(m.commissions)}</td>
        <td class="num">${pct(m.shareOfTeamRentals)}</td>
      </tr>`;
    }
    html += `<tr style="background:#f1efe8"><td><strong>Total</strong></td>
      <td class="num"><strong>${int(cl.total.rentals)}</strong></td>
      <td class="num"><strong>${money(cl.total.counterDollars)}</strong></td>
      <td class="num"><strong>${money(cl.total.commissions)}</strong></td>
      <td class="num"><strong>${pct(cl.total.shareOfTeamRentals)}</strong></td>
    </tr></tbody></table>`;
  }

  // Attach % heatmap (team)
  html += `<h3>Attach % heatmap — team, ${months.length} months</h3>
  <table><thead><tr><th>Service</th>${monthLabels.map((m) => `<th class="num">${escapeHtml(m)}</th>`).join('')}<th class="num">Δ</th></tr></thead><tbody>`;
  for (const row of teamAttach) {
    html += `<tr><td>${escapeHtml(row.label)}</td>`;
    row.byMonth.forEach((p) => {
      html += `<td class="num ${heatClass(p)}">${pct(p)}</td>`;
    });
    html += `<td class="num">${deltaSpan(row.delta)}</td></tr>`;
  }
  html += `</tbody></table>`;

  return html;
}

// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { teamMonthly, teamTotal, clerks, teamAttach, monthLabels } = data;
  const title = 'Rental Agent Track Record — Month over Month';
  const subtitle = `${data.range.from.slice(0, 10)} → ${data.range.to.slice(0, 10)}`;

  const teamSheetRows = teamMonthly.map((m) => ({
    month: m.monthLabel,
    rentals: m.rentals,
    days: m.totalDays,
    counterDollars: m.counterDollars,
    avgPerRental: m.avgDollarsPerRental,
    commissions: m.commissions,
    commPerRental: m.commissionPerRental,
  }));
  teamSheetRows.push({
    month: 'TOTAL',
    rentals: teamTotal.rentals,
    days: teamTotal.totalDays,
    counterDollars: teamTotal.counterDollars,
    avgPerRental: teamTotal.avgDollarsPerRental,
    commissions: teamTotal.commissions,
    commPerRental: teamTotal.commissionPerRental,
  });

  const sheets = [
    {
      name: 'Team monthly',
      bannerRows: [[title], [subtitle]],
      columns: [
        { header: 'Month',         key: 'month',          width: 14 },
        { header: 'Rentals',       key: 'rentals',        width: 10, type: 'integer' },
        { header: 'Days',          key: 'days',           width: 10, type: 'integer' },
        { header: 'Counter $',     key: 'counterDollars', width: 14, type: 'currency' },
        { header: 'Avg $/Rental',  key: 'avgPerRental',   width: 13, type: 'currency' },
        { header: 'Commissions',   key: 'commissions',    width: 13, type: 'currency' },
        { header: 'Comm $/Rental', key: 'commPerRental',  width: 13, type: 'currency' },
      ],
      rows: teamSheetRows,
    },
  ];

  for (const cl of clerks) {
    const rows = cl.monthly.map((m) => ({
      month: m.monthLabel,
      rentals: m.rentals,
      counterDollars: m.counterDollars,
      commissions: m.commissions,
      shareTeam: m.shareOfTeamRentals,
    }));
    rows.push({
      month: 'TOTAL',
      rentals: cl.total.rentals,
      counterDollars: cl.total.counterDollars,
      commissions: cl.total.commissions,
      shareTeam: cl.total.shareOfTeamRentals,
    });
    sheets.push({
      name: cl.name.slice(0, 28), // Excel sheet name limit
      bannerRows: [[`${cl.name} — Track Record`], [subtitle]],
      columns: [
        { header: 'Month',         key: 'month',          width: 14 },
        { header: 'Rentals',       key: 'rentals',        width: 10, type: 'integer' },
        { header: 'Counter $',     key: 'counterDollars', width: 14, type: 'currency' },
        { header: 'Commissions',   key: 'commissions',    width: 13, type: 'currency' },
        { header: '% Team',        key: 'shareTeam',      width: 10, type: 'percent' },
      ],
      rows,
    });
  }

  // Attach heatmap sheet
  const attachRows = teamAttach.map((row) => {
    const obj = { service: row.label, comm: `$${row.commPerSale}` };
    monthLabels.forEach((lbl, i) => { obj[`m_${i}`] = row.byMonth[i]; });
    obj.delta = row.delta;
    obj.benchmark = row.benchmark;
    return obj;
  });
  sheets.push({
    name: 'Attach heatmap',
    bannerRows: [[`${title} — Attach %`], [subtitle]],
    columns: [
      { header: 'Service', key: 'service', width: 22 },
      { header: '$/Sale',  key: 'comm',    width: 10 },
      ...monthLabels.map((lbl, i) => ({ header: lbl, key: `m_${i}`, width: 12, type: 'percent' })),
      { header: 'Δ',         key: 'delta',     width: 10, type: 'percent' },
      { header: 'Benchmark', key: 'benchmark', width: 14 },
    ],
    rows: attachRows,
  });

  return { title, subtitle, sheets };
}

// ---------------------------------------------------------------------------

registerReport({
  slug: 'agent-track-record',
  title: 'Rental Agent Track Record — Month over Month',
  computeData,
  renderHtml,
  buildExcelSpec,
});

export const _agentTrackInternal = { computeData, rangeMonths, monthKey, monthLabel };
