/**
 * Airport Report (LAWA) — 2026-07-29. Airport-concession compliance export
 * matching the RAReporting format LAWA expects, one row per PICKED-UP
 * reservation at the selected location:
 *
 *   R/A Number · PO Number · Source of Business · Postal Code · Agent Out ·
 *   Rental Days · Optional Service List · Total Bill · Total Bill Total Tax
 *   Charge · Renter Payments · Total Daily Extra - Custom
 *
 *   GET /api/reports/airport-lawa?from=YYYY-MM-DD&to=YYYY-MM-DD&locationId=...
 *
 * Column mapping (all confirmed against the live writers):
 *   R/A Number      → Reservation.reservationNumber
 *   PO Number       → Reservation.sourceRef for franchise imports (the raw
 *                     external confirmation promote.js stores); synthetic
 *                     prefixed refs (PUBLICBOOK:/CARSHARE:/LOANER:/QUOTE:)
 *                     and staff nulls render blank.
 *   Source          → bookingChannel, FRANCHISE_X → X, STAFF → WALK-IN.
 *   Postal Code     → customer.zip
 *   Agent Out       → CHECKOUT inspection actorUserId (the house pattern —
 *                     agent-track-record.report.js) → salesOwnerUserId →
 *                     checkoutSession.startedByUserId; names batch-resolved.
 *   Rental Days     → ceil(returnAt - pickupAt), min 1
 *   Services        → agreement charges in SOLD_ITEM_SOURCES (code || name)
 *   Total Bill      → agreement.total (tax-inclusive, deposits excluded)
 *   Total Tax       → agreement.taxes
 *   Renter Payments → agreement.paidAmount (PAID payments, AUTH_HOLD excluded)
 *   Extension Extra → sum of selected agreement charges code=EXTENSION_RATE
 *                     (a subset of Total Bill, reported separately per LAWA)
 *
 * Rows without an agreement (rare — legacy) fall back to estimatedTotal for
 * Total Bill and blanks elsewhere.
 */

import { registerReport } from './reports-v2.routes.js';
import { parseDateTimeInTz, DEFAULT_TENANT_TIMEZONE } from '../../lib/date-utils.js';
import { settingsService } from '../settings/settings.service.js';
import { isSoldItemCharge } from '../../lib/sold-items.js';

const PICKED_UP_STATUSES = ['CHECKED_OUT', 'CHECKED_IN', 'CHECKED_IN_UNPAID'];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function resolveTenantTimeZone(tenantId) {
  if (!tenantId) return DEFAULT_TENANT_TIMEZONE;
  try {
    const options = await settingsService.getReservationOptions({ tenantId });
    return String(options?.tenantTimeZone || DEFAULT_TENANT_TIMEZONE);
  } catch {
    return DEFAULT_TENANT_TIMEZONE;
  }
}

/** Half-open [start, end) UTC range for the requested days in tenant TZ.
 * Defaults to month-to-date. */
function rangeBounds(params, tenantTz) {
  const q = params?.query || {};
  const fromRaw = String(q.from ?? params?.from ?? '').slice(0, 10);
  const toRaw = String(q.to ?? params?.to ?? '').slice(0, 10);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const defFrom = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const defTo = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : defFrom;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : defTo;
  const start = parseDateTimeInTz(`${from}T00:00:00`, tenantTz);
  const endDay = parseDateTimeInTz(`${to}T00:00:00`, tenantTz);
  const end = new Date(endDay.getTime() + 24 * 60 * 60 * 1000);
  return { from, to, start, end };
}

/** FRANCHISE_ECONOMY → ECONOMY, STAFF → WALK-IN, everything else verbatim. */
export function sourceOfBusiness(bookingChannel) {
  const raw = String(bookingChannel || 'STAFF').trim().toUpperCase();
  if (raw.startsWith('FRANCHISE_')) return raw.slice('FRANCHISE_'.length);
  if (raw === 'STAFF') return 'WALK-IN';
  return raw;
}

/** The external confirmation, only when it IS one — synthetic prefixed refs
 * (PUBLICBOOK:/CARSHARE:/LOANER:/QUOTE:) are internal keys, not POs. */
export function poNumber(sourceRef) {
  const s = String(sourceRef || '').trim();
  if (!s || s.includes(':')) return '';
  return s;
}

export function rentalDays(pickupAt, returnAt) {
  const start = new Date(pickupAt || 0).getTime();
  const end = new Date(returnAt || 0).getTime();
  if (!start || !end || end <= start) return 1;
  return Math.max(1, Math.ceil((end - start) / (24 * 60 * 60 * 1000)));
}

/** Selected optional services on the agreement — "code || name", joined. */
export function serviceList(charges = []) {
  const out = [];
  for (const row of charges) {
    if (!isSoldItemCharge(row)) continue;
    const label = String(row.code || row.name || '').trim();
    if (label && !out.includes(label)) out.push(label);
  }
  return out.join(', ');
}

export function extensionExtra(charges = []) {
  let sum = 0;
  for (const row of charges) {
    if (row?.selected === false) continue;
    if (String(row?.code || '').trim().toUpperCase() !== 'EXTENSION_RATE') continue;
    sum += num(row.total);
  }
  return Number(sum.toFixed(2));
}

// ---------------------------------------------------------------------------
// computeData
// ---------------------------------------------------------------------------

export async function computeData(params, deps = {}) {
  if (!params?.tenantId) throw new Error('tenantId required');
  const prisma = deps.prisma || (await import('../../lib/prisma.js')).prisma;

  const tenantTz = await resolveTenantTimeZone(params.tenantId);
  const { from, to, start, end } = rangeBounds(params, tenantTz);
  const locationId = String(params?.query?.locationId ?? params?.locationId ?? '').trim() || null;

  const reservations = await prisma.reservation.findMany({
    where: {
      tenantId: params.tenantId,
      status: { in: PICKED_UP_STATUSES },
      pickupAt: { gte: start, lt: end },
      ...(locationId ? { pickupLocationId: locationId } : {}),
    },
    orderBy: [{ pickupAt: 'asc' }],
    select: {
      id: true,
      reservationNumber: true,
      sourceRef: true,
      bookingChannel: true,
      pickupAt: true,
      returnAt: true,
      estimatedTotal: true,
      customer: { select: { zip: true } },
      pickupLocation: { select: { id: true, name: true, code: true } },
      checkoutSessions: { select: { startedByUserId: true } },
      rentalAgreement: {
        select: {
          total: true, taxes: true, paidAmount: true,
          salesOwnerUserId: true,
          inspections: { where: { phase: 'CHECKOUT' }, select: { actorUserId: true } },
          charges: {
            where: { selected: true },
            select: { code: true, name: true, source: true, chargeType: true, total: true, selected: true },
          },
        },
      },
    },
    take: 5000,
  });

  // Batch-resolve agent names (the agent-track-record pattern — no relation
  // exists on inspection.actorUserId / session.startedByUserId).
  const userIds = new Set();
  for (const r of reservations) {
    const agentId = r.rentalAgreement?.inspections?.[0]?.actorUserId
      || r.rentalAgreement?.salesOwnerUserId
      || r.checkoutSessions?.[0]?.startedByUserId;
    if (agentId) userIds.add(agentId);
  }
  const users = userIds.size
    ? await prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, fullName: true, email: true } })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.fullName || u.email || u.id]));

  const rows = reservations.map((r) => {
    const ag = r.rentalAgreement || null;
    const agentId = ag?.inspections?.[0]?.actorUserId || ag?.salesOwnerUserId || r.checkoutSessions?.[0]?.startedByUserId || null;
    const charges = ag?.charges || [];
    return {
      raNumber: r.reservationNumber,
      poNumber: poNumber(r.sourceRef),
      source: sourceOfBusiness(r.bookingChannel),
      postalCode: String(r.customer?.zip || '').trim(),
      agentOut: agentId ? (nameById.get(agentId) || '') : '',
      rentalDays: rentalDays(r.pickupAt, r.returnAt),
      services: serviceList(charges),
      totalBill: ag ? num(ag.total) : num(r.estimatedTotal),
      totalTax: ag ? num(ag.taxes) : 0,
      renterPayments: ag ? num(ag.paidAmount) : 0,
      extensionExtra: extensionExtra(charges),
    };
  });

  const totals = rows.reduce((acc, r) => {
    acc.totalBill += r.totalBill;
    acc.totalTax += r.totalTax;
    acc.renterPayments += r.renterPayments;
    acc.extensionExtra += r.extensionExtra;
    return acc;
  }, { totalBill: 0, totalTax: 0, renterPayments: 0, extensionExtra: 0 });
  for (const k of Object.keys(totals)) totals[k] = Number(totals[k].toFixed(2));

  const location = locationId ? reservations[0]?.pickupLocation || null : null;

  return {
    range: { from, to, label: `${from} → ${to}` },
    locationId,
    locationLabel: location ? `${location.name} (${location.code})` : (locationId ? locationId : 'All locations'),
    rows,
    totals,
    count: rows.length,
    tenantTimeZone: tenantTz,
  };
}

// ---------------------------------------------------------------------------
// HTML + Excel
// ---------------------------------------------------------------------------

const HEADERS = [
  'R/A Number', 'PO Number', 'Source of Business', 'Postal Code', 'Agent Out',
  'Rental Days', 'Optional Service List', 'Total Bill',
  'Total Bill Total Tax Charge', 'Renter Payments', 'Total Daily Extra - Custom',
];

function fmtMoney(n) {
  return num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderHtml(data) {
  const rowsHtml = (data.rows || []).map((r) => `
    <tr>
      <td>${escapeHtml(r.raNumber)}</td>
      <td>${escapeHtml(r.poNumber)}</td>
      <td>${escapeHtml(r.source)}</td>
      <td>${escapeHtml(r.postalCode)}</td>
      <td>${escapeHtml(r.agentOut)}</td>
      <td style="text-align:right">${r.rentalDays}</td>
      <td>${escapeHtml(r.services)}</td>
      <td style="text-align:right">${fmtMoney(r.totalBill)}</td>
      <td style="text-align:right">${fmtMoney(r.totalTax)}</td>
      <td style="text-align:right">${fmtMoney(r.renterPayments)}</td>
      <td style="text-align:right">${fmtMoney(r.extensionExtra)}</td>
    </tr>
  `).join('');

  return `
    <h2>Airport Report (LAWA)</h2>
    <p>${escapeHtml(data.locationLabel)} · ${escapeHtml(data.range?.label || '-')} · ${data.count} rentals</p>
    <table class="report-table">
      <thead><tr>${HEADERS.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rowsHtml}
        <tr class="grand-total">
          <td colspan="7" style="text-align:right"><strong>Totals</strong></td>
          <td style="text-align:right"><strong>${fmtMoney(data.totals?.totalBill)}</strong></td>
          <td style="text-align:right"><strong>${fmtMoney(data.totals?.totalTax)}</strong></td>
          <td style="text-align:right"><strong>${fmtMoney(data.totals?.renterPayments)}</strong></td>
          <td style="text-align:right"><strong>${fmtMoney(data.totals?.extensionExtra)}</strong></td>
        </tr>
      </tbody>
    </table>
  `;
}

export function buildExcelSpec(data) {
  // The sheet mirrors LAWA's RAReporting sample byte-for-byte on headers:
  // headers in row 1, data from row 2, no banner rows — their intake side
  // parses positionally.
  const rows = [HEADERS];
  for (const r of (data.rows || [])) {
    rows.push([
      r.raNumber, r.poNumber, r.source, r.postalCode, r.agentOut,
      r.rentalDays, r.services, num(r.totalBill), num(r.totalTax),
      num(r.renterPayments), num(r.extensionExtra),
    ]);
  }
  return { sheets: [{ name: 'RAReporting REPORTE LAWA', rows }] };
}

registerReport({
  slug: 'airport-lawa',
  title: 'Airport Report (LAWA)',
  category: 'OPERATIONS',
  icon: 'plane',
  description: 'Airport concession compliance — RAReporting format per rental',
  computeData,
  renderHtml,
  buildExcelSpec,
  roles: ['ADMIN', 'OPS', 'SUPER_ADMIN'],
});
