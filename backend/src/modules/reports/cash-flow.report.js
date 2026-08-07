/**
 * Cash Flow — history + forecast (2026-08-07, Hector: "un report que me ensene
 * historial de collected today y una grafica interactiva que muestra cash flow
 * history and forecasting").
 *
 *   GET /api/reports/cash-flow?from=&to=&locationId=&horizon=
 *     { range, history[], forecast[], totals, runRate, byLocation, filters }
 *
 *   GET /api/reports/cash-flow/day?day=<iso>&locationId=<?>
 *     Drill-down: what made up that day — collected payments for a past day,
 *     the specific pickups/returns expected for a future one.
 *
 * MONEY SEMANTICS, inherited deliberately rather than re-derived:
 *   - Collected = COLLECTED_PAYMENT_WHERE (status PAID, AUTH_HOLD excluded).
 *     The same filter the "Collected today" tile uses, so this report and that
 *     tile can never disagree — the $336k-vs-$47.5k snapshot inflation of
 *     2026-07 came from one surface inventing its own filter.
 *   - Day bucketing is TENANT-LOCAL. A 03:00 UTC capture belongs to the AST
 *     day the agent actually worked.
 *
 * The forecast model (committed vs projected, the weekday run-rate and the
 * subtraction that stops double-counting) lives in cash-flow-math.js.
 */

import { registerReport } from './reports-v2.routes.js';
import { COLLECTED_PAYMENT_WHERE } from './collected-payments.js';
import { resolveTenantTimeZone } from '../../lib/tenant-tz.js';
import { startOfDayInTz, addDaysInTz, isoDayInTz } from '../../lib/date-utils.js';
import {
  weekdayRunRate,
  buildForecastSeries,
  expectedInflow,
  committedByDayFrom,
  summarize,
  round2,
  addIsoDays,
} from './cash-flow-math.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_DAYS = 180;
const MAX_HORIZON_DAYS = 90;
const DEFAULT_HISTORY_DAYS = 30;
const DEFAULT_HORIZON_DAYS = 30;

let _prisma = null;
async function resolvePrisma() {
  if (!_prisma) ({ prisma: _prisma } = await import('../../lib/prisma.js'));
  return _prisma;
}

const money = (v) => `$${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayLabel = (iso) => {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', weekday: 'short' });
};

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, from, to, query }, deps = {}) {
  const prisma = deps.prisma || (await resolvePrisma());
  if (!tenantId) throw new Error('tenantId required');

  const tz = deps.tenantTz || (await resolveTenantTimeZone(tenantId));
  const locationId = (query && query.locationId) || null;
  const now = deps.now || new Date();

  const todayStart = startOfDayInTz(now, tz);
  const historyEnd = to ? startOfDayInTz(to, tz) : todayStart;
  const historyStart = from
    ? startOfDayInTz(from, tz)
    : addDaysInTz(historyEnd, -(DEFAULT_HISTORY_DAYS - 1));
  const rawHistoryDays = Math.round((historyEnd - historyStart) / DAY_MS) + 1;
  const historyDayCount = Math.min(Math.max(1, rawHistoryDays), MAX_HISTORY_DAYS);
  const historyWindowEnd = addDaysInTz(historyStart, historyDayCount);

  const horizonDays = Math.min(
    Math.max(0, Number(query?.horizon) || DEFAULT_HORIZON_DAYS),
    MAX_HORIZON_DAYS
  );

  const locationScope = locationId ? { pickupLocationId: locationId } : {};

  // ---- HISTORY: what actually landed -------------------------------------
  const payments = await prisma.rentalAgreementPayment.findMany({
    where: {
      rentalAgreement: { tenantId, ...locationScope },
      ...COLLECTED_PAYMENT_WHERE,
      paidAt: { gte: historyStart, lt: historyWindowEnd },
    },
    select: {
      amount: true,
      paidAt: true,
      method: true,
      rentalAgreement: {
        select: { reservation: { select: { pickupLocation: { select: { id: true, code: true, name: true } } } } },
      },
    },
  });

  const history = [];
  const histIdx = new Map();
  for (let i = 0; i < historyDayCount; i += 1) {
    const d = addDaysInTz(historyStart, i);
    const iso = isoDayInTz(d, tz);
    histIdx.set(iso, history.length);
    history.push({ iso, label: dayLabel(iso), collected: 0, count: 0 });
  }

  const byLocationMap = new Map();
  const byMethod = {};
  for (const p of payments) {
    const iso = isoDayInTz(p.paidAt, tz);
    const idx = histIdx.get(iso);
    const amount = Number(p.amount || 0);
    if (idx != null) {
      history[idx].collected = round2(history[idx].collected + amount);
      history[idx].count += 1;
    }
    const loc = p.rentalAgreement?.reservation?.pickupLocation || null;
    const key = loc?.id || 'none';
    if (!byLocationMap.has(key)) {
      byLocationMap.set(key, { locationId: loc?.id || null, code: loc?.code || null, name: loc?.name || null, amount: 0 });
    }
    byLocationMap.get(key).amount = round2(byLocationMap.get(key).amount + amount);
    const m = String(p.method || 'OTHER').toUpperCase();
    byMethod[m] = round2((byMethod[m] || 0) + amount);
  }
  const byLocation = [...byLocationMap.values()].sort((a, b) => b.amount - a.amount);

  // ---- FORECAST: what is expected ----------------------------------------
  // The run-rate always reads the trailing 8 weeks ending today, INDEPENDENT
  // of the history window the user is looking at — otherwise zooming the
  // chart to a slow week would quietly re-forecast the whole future.
  const rateStart = addDaysInTz(todayStart, -55);
  const ratePayments = rateStart < historyStart
    ? await prisma.rentalAgreementPayment.findMany({
      where: {
        rentalAgreement: { tenantId, ...locationScope },
        ...COLLECTED_PAYMENT_WHERE,
        paidAt: { gte: rateStart, lt: addDaysInTz(todayStart, 1) },
      },
      select: { amount: true, paidAt: true },
    })
    : null;

  const rateDays = new Map();
  for (let i = 0; i < 56; i += 1) rateDays.set(isoDayInTz(addDaysInTz(rateStart, i), tz), 0);
  for (const p of (ratePayments || payments)) {
    const iso = isoDayInTz(p.paidAt, tz);
    if (rateDays.has(iso)) rateDays.set(iso, round2(rateDays.get(iso) + Number(p.amount || 0)));
  }
  const todayIso = isoDayInTz(todayStart, tz);
  const runRate = weekdayRunRate(
    [...rateDays.entries()].map(([iso, collected]) => ({ iso, collected })),
    { weeks: 8, asOf: todayIso }
  );

  let forecast = [];
  let inflows = [];
  // Money owed on contracts whose return date already passed — collectible
  // now, but undated, so it is reported separately from the daily series.
  const overdue = { total: 0, count: 0, oldest: null };
  if (horizonDays > 0) {
    const forecastStartIso = addIsoDays(todayIso, 1);
    const forecastEnd = addDaysInTz(todayStart, horizonDays + 1);

    // (a) Future pickups: confirmed bookings not yet collected. estimatedTotal
    //     minus whatever the customer already prepaid.
    const upcoming = await prisma.reservation.findMany({
      where: {
        tenantId,
        ...(locationId ? { pickupLocationId: locationId } : {}),
        status: { in: ['NEW', 'CONFIRMED'] },
        pickupAt: { gt: todayStart, lt: forecastEnd },
      },
      select: {
        id: true, reservationNumber: true, pickupAt: true, estimatedTotal: true,
        payments: { where: { status: 'PAID' }, select: { amount: true } },
        rentalAgreement: { select: { id: true } },
      },
    });
    for (const r of upcoming) {
      // A reservation that already has an agreement is counted through the
      // agreement's balance below — never twice.
      if (r.rentalAgreement?.id) continue;
      const paid = (r.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      const row = expectedInflow({
        kind: 'PICKUP',
        dateIso: isoDayInTz(r.pickupAt, tz),
        expectedTotal: r.estimatedTotal,
        alreadyPaid: paid,
      });
      if (row) inflows.push({ ...row, ref: r.reservationNumber, id: r.id });
    }

    // (b) Open contracts: the balance settles at return.
    const openAgreements = await prisma.rentalAgreement.findMany({
      where: {
        tenantId,
        status: { notIn: ['CLOSED', 'CANCELLED'] },
        balance: { gt: 0 },
        ...(locationId ? { reservation: { pickupLocationId: locationId } } : {}),
      },
      select: {
        id: true, agreementNumber: true, balance: true,
        reservation: { select: { id: true, reservationNumber: true, returnAt: true } },
      },
    });
    for (const a of openAgreements) {
      const returnAt = a.reservation?.returnAt;
      if (!returnAt) continue;
      const iso = isoDayInTz(returnAt, tz);
      // PAST-DUE BALANCES ARE NOT A FORECAST (found against live data,
      // 2026-08-07: IRC carries $42.9k of them, and dating that pile to
      // "tomorrow" made tomorrow look like a windfall). It is real money and
      // it is collectible TODAY, but nothing about it predicts WHEN it
      // arrives — so it gets its own number the operator can act on, and it
      // never enters the daily series.
      if (iso <= todayIso) {
        const owed = round2(Number(a.balance || 0));
        if (owed > 0) {
          overdue.total = round2(overdue.total + owed);
          overdue.count += 1;
          if (overdue.oldest == null || iso < overdue.oldest) overdue.oldest = iso;
        }
        continue;
      }
      if (iso >= addIsoDays(todayIso, horizonDays + 1)) continue;
      const row = expectedInflow({ kind: 'RETURN', dateIso: iso, expectedTotal: a.balance, alreadyPaid: 0 });
      if (row) inflows.push({ ...row, ref: a.agreementNumber || a.reservation?.reservationNumber, id: a.id });
    }

    forecast = buildForecastSeries({
      startIso: forecastStartIso,
      days: horizonDays,
      committedByDay: committedByDayFrom(inflows),
      runRate,
    }).map((d) => ({ ...d, label: dayLabel(d.iso) }));
  }

  const totals = summarize({ history, forecast });

  return {
    range: { from: history[0]?.iso || null, to: history[history.length - 1]?.iso || null, tz, today: todayIso },
    history,
    forecast,
    totals,
    runRate,
    byLocation,
    byMethod,
    overdue,
    inflowCount: inflows.length,
    filters: { locationId: locationId || null, horizonDays },
    truncated: rawHistoryDays > MAX_HISTORY_DAYS ? { requestedDays: rawHistoryDays, cappedTo: MAX_HISTORY_DAYS } : null,
  };
}

// ---------------------------------------------------------------------------
// Drill-down: what made up one day
// ---------------------------------------------------------------------------

async function dayDrillDownHandler(req, res, ctx) {
  const prisma = await resolvePrisma();
  const tenantId = ctx?.tenantId;
  const day = String(req.query?.day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'day=YYYY-MM-DD is required' });
  const locationId = req.query?.locationId || null;
  const tz = await resolveTenantTimeZone(tenantId);
  const start = startOfDayInTz(`${day}T12:00:00Z`, tz);
  const end = addDaysInTz(start, 1);
  const locationScope = locationId ? { pickupLocationId: locationId } : {};
  const todayIso = isoDayInTz(new Date(), tz);

  if (day <= todayIso) {
    const rows = await prisma.rentalAgreementPayment.findMany({
      where: {
        rentalAgreement: { tenantId, ...locationScope },
        ...COLLECTED_PAYMENT_WHERE,
        paidAt: { gte: start, lt: end },
      },
      select: {
        amount: true, method: true, reference: true, paidAt: true,
        rentalAgreement: { select: { agreementNumber: true, reservation: { select: { reservationNumber: true, pickupLocation: { select: { code: true } } } } } },
      },
      orderBy: { paidAt: 'asc' },
    });
    return res.json({
      day, kind: 'HISTORY',
      total: round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0)),
      rows: rows.map((r) => ({
        at: r.paidAt, amount: round2(Number(r.amount || 0)), method: r.method, reference: r.reference,
        agreementNumber: r.rentalAgreement?.agreementNumber || null,
        reservationNumber: r.rentalAgreement?.reservation?.reservationNumber || null,
        location: r.rentalAgreement?.reservation?.pickupLocation?.code || null,
      })),
    });
  }

  // Future day: the committed rows that put money there.
  const [pickups, returns] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        tenantId, ...(locationId ? { pickupLocationId: locationId } : {}),
        status: { in: ['NEW', 'CONFIRMED'] },
        pickupAt: { gte: start, lt: end },
        rentalAgreement: null,
      },
      select: {
        id: true, reservationNumber: true, estimatedTotal: true, pickupAt: true,
        customer: { select: { firstName: true, lastName: true } },
        payments: { where: { status: 'PAID' }, select: { amount: true } },
      },
    }),
    prisma.rentalAgreement.findMany({
      where: {
        tenantId, status: { notIn: ['CLOSED', 'CANCELLED'] }, balance: { gt: 0 },
        ...(locationId ? { reservation: { pickupLocationId: locationId } } : {}),
        reservation: { returnAt: { gte: start, lt: end }, ...(locationId ? { pickupLocationId: locationId } : {}) },
      },
      select: { id: true, agreementNumber: true, balance: true, reservation: { select: { reservationNumber: true, returnAt: true } } },
    }),
  ]);

  const rows = [
    ...pickups.map((r) => {
      const paid = (r.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
      return {
        kind: 'PICKUP', at: r.pickupAt,
        amount: round2(Number(r.estimatedTotal || 0) - paid),
        reservationNumber: r.reservationNumber,
        customer: [r.customer?.firstName, r.customer?.lastName].filter(Boolean).join(' ') || null,
      };
    }).filter((r) => r.amount > 0),
    ...returns.map((a) => ({
      kind: 'RETURN', at: a.reservation?.returnAt,
      amount: round2(Number(a.balance || 0)),
      agreementNumber: a.agreementNumber,
      reservationNumber: a.reservation?.reservationNumber || null,
    })),
  ].sort((x, y) => new Date(x.at) - new Date(y.at));

  res.json({ day, kind: 'FORECAST', total: round2(rows.reduce((s, r) => s + r.amount, 0)), rows });
}

// ---------------------------------------------------------------------------
// PDF / Excel
// ---------------------------------------------------------------------------

function renderHtml(data) {
  const t = data?.totals || {};
  const histRows = (data.history || []).map((d) => `<tr><td>${esc(d.label)}</td><td class="num">${d.count}</td><td class="num">${money(d.collected)}</td></tr>`).join('');
  const foreRows = (data.forecast || []).map((d) => `<tr><td>${esc(d.label)}</td><td class="num">${money(d.committed)}</td><td class="num">${money(d.projected)}</td><td class="num">${money(d.total)}</td></tr>`).join('');
  const locRows = (data.byLocation || []).map((l) => `<tr><td>${esc(l.code || l.name || 'Unassigned')}</td><td class="num">${money(l.amount)}</td></tr>`).join('');
  return `
    <style>.num{text-align:right;font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;margin:8px 0 18px}th,td{padding:4px 6px;border-bottom:1px solid #e5e5e5;font-size:11px}th{text-align:left;background:#f6f5f2}h3{margin:14px 0 4px;font-size:13px}</style>
    <table>
      <tr><th>Collected in period</th><td class="num">${money(t.historyCollected)}</td>
          <th>Daily average</th><td class="num">${money(t.historyDailyAverage)}</td></tr>
      <tr><th>Committed ahead</th><td class="num">${money(t.forecastCommitted)}</td>
          <th>Projected ahead</th><td class="num">${money(t.forecastProjected)}</td></tr>
      <tr><th>Past-due balances</th><td class="num">${money(data?.overdue?.total)}</td>
          <th>Contracts past due</th><td class="num">${Number(data?.overdue?.count || 0)}</td></tr>
    </table>
    ${locRows ? `<h3>Collected by location</h3><table><tr><th>Location</th><th class="num">Collected</th></tr>${locRows}</table>` : ''}
    <h3>History</h3>
    <table><tr><th>Day</th><th class="num">Payments</th><th class="num">Collected</th></tr>${histRows || '<tr><td colspan="3">No payments in range</td></tr>'}</table>
    ${foreRows ? `<h3>Forecast — committed is booked money; projected is the weekday run-rate for bookings not yet made</h3>
    <table><tr><th>Day</th><th class="num">Committed</th><th class="num">Projected</th><th class="num">Expected</th></tr>${foreRows}</table>` : ''}
  `;
}

function buildExcelSpec(data) {
  const t = data?.totals || {};
  return {
    title: 'Cash Flow',
    subtitle: `${data?.range?.from || ''} → ${data?.range?.to || ''} · forecast ${data?.filters?.horizonDays || 0} days`,
    sheets: [
      {
        name: 'History',
        bannerRows: [['Cash Flow — collected history'], [`Total ${money(t.historyCollected)} · daily avg ${money(t.historyDailyAverage)}`]],
        columns: [
          { header: 'Day', key: 'label', width: 16 },
          { header: 'Payments', key: 'count', width: 10, type: 'number' },
          { header: 'Collected', key: 'collected', width: 14, type: 'money' },
        ],
        rows: data.history || [],
        footerRow: { label: 'TOTAL', count: (data.history || []).reduce((s, d) => s + d.count, 0), collected: t.historyCollected },
      },
      {
        name: 'Forecast',
        bannerRows: [['Cash Flow — forecast'], ['Committed = booked money. Projected = weekday run-rate for bookings not yet made.']],
        columns: [
          { header: 'Day', key: 'label', width: 16 },
          { header: 'Committed', key: 'committed', width: 14, type: 'money' },
          { header: 'Projected', key: 'projected', width: 14, type: 'money' },
          { header: 'Expected', key: 'total', width: 14, type: 'money' },
        ],
        rows: data.forecast || [],
        footerRow: { label: 'TOTAL', committed: t.forecastCommitted, projected: t.forecastProjected, total: t.forecastTotal },
      },
    ],
  };
}

registerReport({
  slug: 'cash-flow',
  title: 'Cash Flow',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [{ path: '/day', method: 'get', handler: dayDrillDownHandler }],
});

export const _cashFlowInternal = { computeData, dayDrillDownHandler };
