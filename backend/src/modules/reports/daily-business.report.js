/**
 * Daily Business Report with Posting — Rent & Go's accounting hand-off.
 *
 * Replaces the report their previous software produced (sample "KENN JULIO
 * 2026"). The math and every grouping decision live in daily-business.math.js
 * and are unit-tested; this file is the IO: what to query, and how to draw it.
 *
 *   GET /api/reports/daily-business?from=&to=&cutoff=&locationId=
 *     → { range, cutoff, days[], journal, accounts, filters, truncated }
 *
 * THE CUTOFF is what makes this an accounting document rather than an
 * operational one. `to` bounds the business days shown; `cutoff` bounds WHEN a
 * transaction may have been recorded to count. Without it a closed period
 * silently changes the next time somebody back-dates a payment, and the
 * accountant's posted entry stops matching the report it came from.
 *
 * ACCOUNT NUMBERS are placeholders (0001, 0002, …) until Rent & Go's
 * accountant provides the real chart of accounts (Hector, 2026-08-17). They
 * are derived deterministically from the group keys, so the same books always
 * number the same way and a mapping table can replace them later without the
 * rest of this file changing.
 */

import { registerReport } from './reports-v2.routes.js';
import { prisma } from '../../lib/prisma.js';
import { DEFAULT_TENANT_TIMEZONE, isoDayInTz } from '../../lib/date-utils.js';
import { settingsService } from '../settings/settings.service.js';
import {
  groupOf, summarizeDay, buildJournal, assignPlaceholderAccounts, sumMoney, DEFERRAL_KEY,
} from './daily-business.math.js';

const MAX_DAYS = 92;
const MAX_ROWS = 5000;

async function tenantTimeZone(tenantId) {
  if (!tenantId) return DEFAULT_TENANT_TIMEZONE;
  try {
    const o = await settingsService.getReservationOptions({ tenantId });
    return String(o?.tenantTimeZone || DEFAULT_TENANT_TIMEZONE);
  } catch { return DEFAULT_TENANT_TIMEZONE; }
}

const money = (v) => Math.round(Number(v || 0) * 100) / 100;
const dayStart = (iso) => new Date(`${iso}T00:00:00.000Z`);
const dayEnd = (iso) => new Date(`${iso}T23:59:59.999Z`);

function defaultRange() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
  return { from, to };
}

/** Last four of a card / account, never the whole number. */
function maskReference(ref) {
  const s = String(ref || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 4) return `****${digits.slice(-4)}`;
  return s.slice(0, 24);
}

async function computeData({ tenantId, from, to, query = {} }) {
  const tz = await tenantTimeZone(tenantId);
  const range = {
    from: String(from || query.from || defaultRange().from).slice(0, 10),
    to: String(to || query.to || defaultRange().to).slice(0, 10),
  };
  // The cutoff defaults to the end of the window: run it today for last week
  // and you get last week as it stands today, which is what "run the report"
  // has always meant. An explicit cutoff is how a closed period stays closed.
  const cutoff = String(query.cutoff || range.to).slice(0, 10);
  const locationId = String(query.locationId || '').trim() || null;

  const days = Math.round((dayStart(range.to) - dayStart(range.from)) / 86400000) + 1;
  if (!Number.isFinite(days) || days < 1) throw Object.assign(new Error('Invalid date range'), { status: 400 });
  if (days > MAX_DAYS) {
    throw Object.assign(new Error(`Range too wide — ${MAX_DAYS} days maximum`), { status: 400 });
  }

  const windowStart = dayStart(range.from);
  const windowEnd = dayEnd(range.to);
  const cutoffAt = dayEnd(cutoff);
  const locWhere = locationId ? { id: locationId } : {};

  const locations = await prisma.location.findMany({
    where: { tenantId, ...locWhere },
    select: { id: true, code: true, name: true },
    orderBy: { name: 'asc' },
  });
  const locById = new Map(locations.map((l) => [l.id, l]));
  const locationIds = locations.map((l) => l.id);
  if (!locationIds.length) {
    return { range, cutoff, tz, days: [], journal: buildJournal({}), accounts: {}, filters: { locationId }, truncated: false };
  }

  // Agreements CLOSED in the window — the accounting event is the close, the
  // same moment the old report keyed its "Contracts Closed" section on.
  const agreements = await prisma.rentalAgreement.findMany({
    where: {
      tenantId,
      closedAt: { gte: windowStart, lte: windowEnd, not: null },
      createdAt: { lte: cutoffAt },
      reservation: locationId ? { pickupLocationId: locationId } : undefined,
    },
    select: {
      id: true, agreementNumber: true, closedAt: true, pickupAt: true, returnAt: true,
      customerFirstName: true, customerLastName: true, closedByUserId: true,
      vehicle: { select: { internalNumber: true, plate: true } },
      reservation: { select: { reservationNumber: true, pickupLocationId: true } },
      charges: {
        where: { selected: true },
        select: { name: true, chargeType: true, total: true },
      },
    },
    take: MAX_ROWS,
    orderBy: { closedAt: 'asc' },
  });

  const payments = await prisma.rentalAgreementPayment.findMany({
    where: {
      status: 'PAID',
      paidAt: { gte: windowStart, lte: windowEnd },
      createdAt: { lte: cutoffAt },
      rentalAgreement: {
        tenantId,
        ...(locationId ? { reservation: { pickupLocationId: locationId } } : {}),
      },
    },
    select: {
      id: true, method: true, amount: true, paidAt: true, reference: true,
      rentalAgreement: {
        select: {
          agreementNumber: true, customerFirstName: true, customerLastName: true,
          reservation: { select: { pickupLocationId: true, reservationNumber: true } },
        },
      },
    },
    take: MAX_ROWS,
    orderBy: { paidAt: 'asc' },
  });

  const truncated = agreements.length >= MAX_ROWS || payments.length >= MAX_ROWS;

  // ── fold into location × day buckets ──────────────────────────────────────
  const buckets = new Map();
  const bucketOf = (locId, iso) => {
    const key = `${locId}|${iso}`;
    if (!buckets.has(key)) {
      const loc = locById.get(locId);
      buckets.set(key, {
        locationId: locId,
        locationCode: loc?.code || '',
        locationName: loc?.name || 'Unassigned',
        day: iso,
        closed: [], voided: [], payments: [], charges: [],
      });
    }
    return buckets.get(key);
  };

  for (const a of agreements) {
    const locId = a.reservation?.pickupLocationId;
    if (!locId || !locById.has(locId)) continue;
    const iso = isoDayInTz(a.closedAt, tz);
    const b = bucketOf(locId, iso);
    const lines = (a.charges || []).map((c) => ({
      name: c.name, chargeType: c.chargeType, total: money(c.total), group: groupOf(c),
    }));
    b.charges.push(...lines);
    const timeTotal = sumMoney(lines.filter((l) => l.group.section === 'TIME').map((l) => l.total));
    b.closed.push({
      number: a.agreementNumber || a.reservation?.reservationNumber || a.id.slice(-6),
      customer: [a.customerFirstName, a.customerLastName].filter(Boolean).join(' '),
      unit: a.vehicle?.internalNumber || a.vehicle?.plate || '',
      out: a.pickupAt, in: a.closedAt,
      days: a.pickupAt && a.returnAt
        ? Math.max(1, Math.ceil((new Date(a.returnAt) - new Date(a.pickupAt)) / 86400000))
        : null,
      employeeId: a.closedByUserId || '',
      time: timeTotal,
      lines: lines.filter((l) => l.group.section !== 'TIME')
        .map((l) => ({ label: l.group.label, amount: l.total })),
      total: sumMoney(lines.map((l) => l.total)),
    });
  }

  for (const p of payments) {
    const locId = p.rentalAgreement?.reservation?.pickupLocationId;
    if (!locId || !locById.has(locId)) continue;
    const iso = isoDayInTz(p.paidAt, tz);
    const b = bucketOf(locId, iso);
    b.payments.push({
      number: p.rentalAgreement?.agreementNumber || p.rentalAgreement?.reservation?.reservationNumber || '',
      customer: [p.rentalAgreement?.customerFirstName, p.rentalAgreement?.customerLastName].filter(Boolean).join(' '),
      // RentalAgreementPayment carries no actor column (unlike ReservationPayment),
      // so the old report's Emp column is blank here until one is added.
      employeeId: '',
      method: String(p.method || '').toUpperCase(),
      amount: money(p.amount),
      reference: maskReference(p.reference),
      at: p.paidAt,
    });
  }

  const dayRows = [...buckets.values()]
    .sort((a, b) => (a.locationName === b.locationName
      ? a.day.localeCompare(b.day)
      : a.locationName.localeCompare(b.locationName)))
    .map((b) => ({
      ...b,
      summary: summarizeDay({ charges: b.charges, payments: b.payments }),
    }));

  // ── one journal for the whole run, per location ───────────────────────────
  const groupTotals = new Map();
  const receiptTotals = new Map();
  for (const d of dayRows) {
    const code = d.locationCode || d.locationName;
    for (const c of d.charges) {
      const g = groupOf(c);
      const key = `${code}|${g.key}`;
      const cur = groupTotals.get(key) || { ...g, locationCode: code, total: 0 };
      cur.total = money(cur.total + c.total);
      groupTotals.set(key, cur);
    }
    for (const r of d.summary.receipts) {
      const key = `${code}|${r.method}`;
      receiptTotals.set(key, {
        method: r.method, locationCode: code,
        total: money((receiptTotals.get(key)?.total || 0) + r.total),
      });
    }
  }

  const accounts = assignPlaceholderAccounts([
    ...[...groupTotals.values()].map((g) => g.key),
    ...[...receiptTotals.values()].map((r) => `RECEIPT:${r.method}`),
    // Always mapped, even in a period where cash and revenue happen to match:
    // an account number that appears only on busy months is a trap.
    DEFERRAL_KEY,
  ]);

  // Journals are built per location so each branch's entry can be posted on
  // its own, then concatenated for the printed document.
  const byLocation = new Map();
  for (const g of groupTotals.values()) {
    if (!byLocation.has(g.locationCode)) byLocation.set(g.locationCode, { groups: [], receipts: [] });
    byLocation.get(g.locationCode).groups.push(g);
  }
  for (const r of receiptTotals.values()) {
    if (!byLocation.has(r.locationCode)) byLocation.set(r.locationCode, { groups: [], receipts: [] });
    byLocation.get(r.locationCode).receipts.push(r);
  }

  const journals = [...byLocation.entries()].map(([code, v]) => ({
    locationCode: code,
    ...buildJournal({ groups: v.groups, receipts: v.receipts, accounts, locationCode: code }),
  }));

  const journal = {
    perLocation: journals,
    lines: journals.flatMap((j) => j.lines),
    totalDebit: sumMoney(journals.map((j) => j.totalDebit)),
    totalCredit: sumMoney(journals.map((j) => j.totalCredit)),
    // Cash taken on rentals that had not closed yet — the figure accounting
    // needs to know is still owed as service, not earned.
    deferral: sumMoney(journals.map((j) => j.deferral)),
    balanced: journals.every((j) => j.balanced),
    unbalancedLocations: journals.filter((j) => !j.balanced).map((j) => ({
      locationCode: j.locationCode, difference: j.difference, note: j.balanceNote,
    })),
  };

  return {
    range, cutoff, tz,
    days: dayRows,
    journal,
    accounts,
    accountsArePlaceholders: true,
    filters: { locationId },
    truncated,
  };
}

const fmt = (n) => Number(n || 0).toFixed(2);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function renderHtml(data) {
  const dayBlocks = (data.days || []).map((d) => `
    <h3>${esc(d.locationName)} — ${esc(d.day)}</h3>
    ${d.closed.length ? `<table><thead><tr><th>RA#</th><th>Customer</th><th>Unit</th><th>Days</th><th class="n">Time</th><th class="n">Total</th></tr></thead><tbody>
      ${d.closed.map((c) => `<tr><td>${esc(c.number)}</td><td>${esc(c.customer)}</td><td>${esc(c.unit)}</td><td>${c.days ?? ''}</td><td class="n">${fmt(c.time)}</td><td class="n">${fmt(c.total)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="muted">No contracts closed.</p>'}
    ${d.payments.length ? `<table><thead><tr><th>RA#</th><th>Customer</th><th>Method</th><th>Reference</th><th class="n">Amount</th></tr></thead><tbody>
      ${d.payments.map((p) => `<tr><td>${esc(p.number)}</td><td>${esc(p.customer)}</td><td>${esc(p.method)}</td><td>${esc(p.reference)}</td><td class="n">${fmt(p.amount)}</td></tr>`).join('')}
    </tbody></table>` : ''}
    <table><tbody>
      <tr><td>Net time &amp; mileage</td><td class="n">${fmt(d.summary.rentalRevenue.netTimeAndMileage)}</td></tr>
      ${d.summary.misc.lines.map((l) => `<tr><td>&nbsp;&nbsp;${esc(l.label)}</td><td class="n">${fmt(l.total)}</td></tr>`).join('')}
      <tr><td>Total misc charges</td><td class="n">${fmt(d.summary.misc.total)}</td></tr>
      ${d.summary.taxes.lines.map((l) => `<tr><td>&nbsp;&nbsp;${esc(l.label)}</td><td class="n">${fmt(l.total)}</td></tr>`).join('')}
      <tr><td>Total fees &amp; taxes</td><td class="n">${fmt(d.summary.taxes.total)}</td></tr>
      <tr><td>Deposits taken</td><td class="n">${fmt(d.summary.depositsTaken)}</td></tr>
      <tr><th>Total of charges &amp; deposits</th><th class="n">${fmt(d.summary.totalChargesAndDeposits)}</th></tr>
      ${d.summary.receipts.map((r) => `<tr><td>&nbsp;&nbsp;${esc(r.method)}</td><td class="n">${fmt(r.total)}</td></tr>`).join('')}
      <tr><th>Total receipts</th><th class="n">${fmt(d.summary.totalReceipts)}</th></tr>
    </tbody></table>`).join('');

  const j = data.journal || {};
  const journalRows = (j.lines || []).map((l) => `<tr><td>${esc(l.account)}</td><td>${esc(l.description)}</td><td class="n">${l.debit ? fmt(l.debit) : ''}</td><td class="n">${l.credit ? fmt(l.credit) : ''}</td></tr>`).join('');

  return `
    <p class="muted">Cutoff ${esc(data.cutoff)} · includes transactions recorded through that date.</p>
    ${data.accountsArePlaceholders ? '<p class="muted"><strong>Account numbers are placeholders</strong> (0001, 0002…) pending the chart of accounts.</p>' : ''}
    ${dayBlocks || '<p class="muted">No activity in this range.</p>'}
    <h3>General Ledger Posting</h3>
    <table><thead><tr><th>Account#</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th></tr></thead>
    <tbody>${journalRows}
      <tr><th colspan="2">${j.balanced ? 'Balanced' : 'OUT OF BALANCE — not postable'}</th><th class="n">${fmt(j.totalDebit)}</th><th class="n">${fmt(j.totalCredit)}</th></tr>
    </tbody></table>
    ${!j.balanced ? `<p class="muted">${(j.unbalancedLocations || []).map((u) => esc(`${u.locationCode}: ${u.note}`)).join('<br/>')}</p>` : ''}`;
}

function buildExcelSpec(data) {
  const sheets = [];
  sheets.push({
    name: 'Journal',
    columns: [
      { header: 'Account#', key: 'account', width: 12 },
      { header: 'Description', key: 'description', width: 42 },
      { header: 'Debit', key: 'debit', width: 14 },
      { header: 'Credit', key: 'credit', width: 14 },
    ],
    rows: [
      ...(data.journal?.lines || []).map((l) => ({
        account: l.account, description: l.description,
        debit: l.debit || null, credit: l.credit || null,
      })),
      { account: '', description: data.journal?.balanced ? 'Balanced' : 'OUT OF BALANCE', debit: data.journal?.totalDebit, credit: data.journal?.totalCredit },
    ],
  });
  sheets.push({
    name: 'Daily summary',
    columns: [
      { header: 'Location', key: 'location', width: 26 },
      { header: 'Day', key: 'day', width: 12 },
      { header: 'Net time', key: 'time', width: 14 },
      { header: 'Misc', key: 'misc', width: 14 },
      { header: 'Taxes', key: 'taxes', width: 14 },
      { header: 'Deposits', key: 'deposits', width: 14 },
      { header: 'Charges + deposits', key: 'total', width: 20 },
      { header: 'Receipts', key: 'receipts', width: 14 },
    ],
    rows: (data.days || []).map((d) => ({
      location: d.locationName, day: d.day,
      time: d.summary.rentalRevenue.netTimeAndMileage,
      misc: d.summary.misc.total,
      taxes: d.summary.taxes.total,
      deposits: d.summary.depositsTaken,
      total: d.summary.totalChargesAndDeposits,
      receipts: d.summary.totalReceipts,
    })),
  });
  sheets.push({
    name: 'Payments',
    columns: [
      { header: 'Location', key: 'location', width: 26 },
      { header: 'Day', key: 'day', width: 12 },
      { header: 'RA#', key: 'number', width: 16 },
      { header: 'Customer', key: 'customer', width: 26 },
      { header: 'Method', key: 'method', width: 14 },
      { header: 'Reference', key: 'reference', width: 18 },
      { header: 'Amount', key: 'amount', width: 14 },
    ],
    rows: (data.days || []).flatMap((d) => d.payments.map((p) => ({
      location: d.locationName, day: d.day, number: p.number,
      customer: p.customer, method: p.method, reference: p.reference, amount: p.amount,
    }))),
  });
  return { filename: `daily-business-${data.range?.to || 'report'}.xlsx`, sheets };
}

registerReport({
  slug: 'daily-business',
  title: 'Daily Business Report with Posting',
  roles: ['ADMIN', 'OPS', 'SUPER_ADMIN'],
  computeData,
  renderHtml,
  buildExcelSpec,
});

export { computeData as _computeData };
