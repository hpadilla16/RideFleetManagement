/**
 * Pre-Paid Reservations report — 2026-05-25 / revised 2026-05-26
 *
 * Monthly recap of COMPLETED rentals, grouped by pickup location. A rental
 * is counted in the report month the customer actually returned the car, so
 * a pickup on May 29 with return on June 1 lands in June's report (when
 * staff close it out at check-in).
 *
 *   GET /api/reports/pre-paid-reservations?year=YYYY&month=MM&channel=FRANCHISE_TL|ALL
 *     Returns { range, groups: [{ locationCode, locationName, rows[], subtotal }],
 *               grandTotal, count, currency, tenantTimeZone, filters }
 *
 * Source: Reservation rows (NOT ExternalReservation). For TL franchise rows
 * we still join the matching ExternalReservation to surface TL's booking date
 * and original totalAmount on the row.
 *
 * Filter semantics:
 *   - year + month gate on Reservation.returnAt, evaluated in the tenant's
 *     timezone window (parseDateTimeInTz). Service-date accounting: revenue
 *     books to the month the rental closed.
 *   - status IN ('CHECKED_IN', 'CHECKED_IN_UNPAID'). Only completed rentals
 *     count — open reservations and cancelled / no-show rows are excluded.
 *   - channel = 'FRANCHISE_TL' (default) → only TL franchise imports.
 *     channel = 'ALL'                   → every bookingChannel (including
 *                                          STAFF, WEBSITE, CAR_SHARING, …).
 *
 * Column mapping:
 *   CUSTOMER     → customer.firstName + ' ' + customer.lastName
 *   BOOKING DATE → ExternalReservation.firstSeenAt (TL rows) /
 *                  Reservation.createdAt (everything else)
 *   COLLECTION   → Reservation.pickupAt
 *   RETURN       → Reservation.returnAt
 *   RES NO       → Reservation.reservationNumber
 *                  (TL rows usually carry the ZE… in sourceRef as well)
 *   VALUE        → ExternalReservation.totalAmount when present
 *                  (the canonical TL pre-paid amount), else
 *                  Reservation.estimatedTotal as a best-effort fallback.
 *
 * Grouping: by pickupLocation. Falls back to "Unknown" when pickupLocation
 * is null (e.g. legacy rows or off-network bookings).
 */

import { registerReport } from './reports-v2.routes.js';
import { parseDateTimeInTz, DEFAULT_TENANT_TIMEZONE } from '../../lib/date-utils.js';
import { settingsService } from '../settings/settings.service.js';

async function resolveTenantTimeZone(tenantId) {
  if (!tenantId) return DEFAULT_TENANT_TIMEZONE;
  try {
    const options = await settingsService.getReservationOptions({ tenantId });
    return String(options?.tenantTimeZone || DEFAULT_TENANT_TIMEZONE);
  } catch {
    return DEFAULT_TENANT_TIMEZONE;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function defaultYearMonth() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

// registerReport passes the express query string under `params.query`, not
// directly on `params`. The pre-revise version read params.year / params.month
// and silently always fell through to defaultYearMonth — that's why switching
// month in the dropdown stuck on the current month's data. Read from
// params.query first, with params.* kept as a fallback for direct callers
// (tests, future internal use).
function parseYearMonth(params) {
  const fallback = defaultYearMonth();
  const q = params?.query || {};
  const y = parseInt(q.year ?? params?.year, 10);
  const m = parseInt(q.month ?? params?.month, 10);
  const year  = Number.isFinite(y) && y >= 2020 && y <= 2100 ? y : fallback.year;
  const month = Number.isFinite(m) && m >= 1 && m <= 12 ? m : fallback.month;
  return { year, month };
}

// Channel filter: 'FRANCHISE_TL' (default — historic report scope) keeps the
// report TL-only; 'ALL' broadens it to every bookingChannel for an
// all-channels monthly recap.
function parseChannel(params) {
  const raw = String(params?.query?.channel ?? params?.channel ?? 'FRANCHISE_TL')
    .trim()
    .toUpperCase();
  return raw === 'ALL' ? 'ALL' : 'FRANCHISE_TL';
}

// Build the half-open [start, end) UTC range for "month X in tenantTz" so
// e.g. May 2026 in PR runs from 2026-05-01T00:00 AST (= 2026-05-01T04:00Z)
// to 2026-06-01T00:00 AST (= 2026-06-01T04:00Z), not the UTC midnight pair.
function monthBoundsInTz(year, month, tenantTz) {
  const pad = (n) => String(n).padStart(2, '0');
  const nextYear  = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const start = parseDateTimeInTz(`${year}-${pad(month)}-01T00:00:00`, tenantTz);
  const end   = parseDateTimeInTz(`${nextYear}-${pad(nextMonth)}-01T00:00:00`, tenantTz);
  return { start, end };
}

function fmtRangeLabel(year, month) {
  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  return `${monthNames[month - 1]} ${year}`;
}

function customerName(row) {
  const f = (row.customerFirstName || '').trim();
  const l = (row.customerLastName  || '').trim();
  const full = `${f} ${l}`.trim();
  return full || '-';
}

// Parse location code from the raw TL pickupLocation field.
// "San Juan Airport (SJUA01)" → "SJUA01"
// "SJUA01"                    → "SJUA01"
// null / unparseable          → "UNKNOWN"
function extractLocationCode(label) {
  if (!label || typeof label !== 'string') return 'UNKNOWN';
  const s = label.trim();
  const paren = s.match(/\(([A-Z0-9]{3,8})\)\s*$/);
  if (paren) return paren[1];
  if (/^[A-Z0-9]{3,8}$/.test(s)) return s;
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// computeData — main query
// ---------------------------------------------------------------------------

export async function computeData(params, deps = {}) {
  if (!params?.tenantId) throw new Error('tenantId required');
  const prisma = deps.prisma || (await import('../../lib/prisma.js')).prisma;

  const { year, month } = parseYearMonth(params);
  const channel = parseChannel(params);
  const tenantTz = await resolveTenantTimeZone(params.tenantId);
  const { start, end } = monthBoundsInTz(year, month, tenantTz);

  // Filter Reservations whose check-in landed inside the requested month and
  // whose status indicates a closed-out rental. CHECKED_IN_UNPAID is included
  // because the rental physically completed — the open balance is a separate
  // collection workflow, not a reason to drop the row from this recap.
  const where = {
    tenantId: params.tenantId,
    status: { in: ['CHECKED_IN', 'CHECKED_IN_UNPAID'] },
    returnAt: { gte: start, lt: end },
  };
  if (channel === 'FRANCHISE_TL') {
    where.bookingChannel = 'FRANCHISE_TL';
  }
  // channel === 'ALL' — no bookingChannel filter, every channel counts.

  const reservations = await prisma.reservation.findMany({
    where,
    orderBy: [{ pickupLocationId: 'asc' }, { returnAt: 'asc' }],
    select: {
      id: true,
      reservationNumber: true,
      sourceRef: true,
      bookingChannel: true,
      pickupAt: true,
      returnAt: true,
      createdAt: true,
      estimatedTotal: true,
      pickupLocationId: true,
      pickupLocation: { select: { id: true, code: true, name: true } },
      customer: { select: { firstName: true, lastName: true } },
    },
  });

  // Resolve the matching ExternalReservation rows so TL franchise rows can
  // surface TL's original booking date (firstSeenAt) and the pre-paid total
  // TL recorded — both of which take precedence over local fallbacks for
  // accounting purposes.
  const tlSourceRefs = reservations
    .filter((r) => r.bookingChannel === 'FRANCHISE_TL' && r.sourceRef)
    .map((r) => r.sourceRef);
  const externalByRef = new Map();
  if (tlSourceRefs.length) {
    const externals = await prisma.externalReservation.findMany({
      where: {
        tenantId: params.tenantId,
        sourceSystem: 'TL_INTERNATIONAL',
        externalRef: { in: tlSourceRefs },
      },
      select: { externalRef: true, firstSeenAt: true, totalAmount: true, currency: true },
    });
    for (const er of externals) externalByRef.set(er.externalRef, er);
  }

  // Group by pickup location id. Falls back to a synthetic "UNKNOWN" bucket
  // when pickupLocation is null so reps still show somewhere instead of
  // silently disappearing from the recap.
  const groupMap = new Map();
  for (const r of reservations) {
    const groupKey = r.pickupLocation?.id || 'UNKNOWN';
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        locationCode: r.pickupLocation?.code || 'UNKNOWN',
        locationName: r.pickupLocation?.name || 'Unknown location',
        rows: [],
        subtotal: 0,
      });
    }
    const g = groupMap.get(groupKey);
    const external = r.sourceRef ? externalByRef.get(r.sourceRef) : null;
    const value = num(external?.totalAmount ?? r.estimatedTotal);
    const firstName = (r.customer?.firstName || '').trim();
    const lastName  = (r.customer?.lastName  || '').trim();
    g.rows.push({
      id: r.id,
      customer: `${firstName} ${lastName}`.trim() || '-',
      // Booking date: when the customer actually committed to this rental.
      // For TL imports that's the moment we first saw the booking in their
      // dashboard; for everything else it's when our reservation row was
      // created (staff entered it, customer portal submitted it, etc.).
      bookingDate: external?.firstSeenAt || r.createdAt,
      collectionDate: r.pickupAt,
      returnDate: r.returnAt,
      reservationNumber: r.reservationNumber,
      externalRef: r.sourceRef || null,
      bookingChannel: r.bookingChannel,
      value,
    });
    g.subtotal += value;
  }

  const groups = Array.from(groupMap.values()).sort((a, b) =>
    a.locationName.localeCompare(b.locationName)
  );
  for (const g of groups) g.subtotal = Number(g.subtotal.toFixed(2));

  const grandTotal = Number(
    groups.reduce((acc, g) => acc + g.subtotal, 0).toFixed(2)
  );
  const count = reservations.length;

  return {
    range: { year, month, label: fmtRangeLabel(year, month), from: start.toISOString(), to: end.toISOString() },
    groups,
    grandTotal,
    count,
    currency: 'USD',
    tenantTimeZone: tenantTz,
    filters: { year, month, channel },
  };
}

// ---------------------------------------------------------------------------
// HTML renderer (for PDF export)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Format a UTC instant as "DD-MM-YYYY HH:mm" in the given tenant TZ. The
// earlier version used getUTC* and silently rendered every timestamp as UTC
// in the agreement PDF + Excel export, four hours ahead of the wall-clock
// the staff actually scheduled.
function fmtDateTimeShort(d, tenantTz = DEFAULT_TENANT_TIMEZONE) {
  if (!d) return '-';
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tenantTz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  }).formatToParts(x).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.day}-${parts.month}-${parts.year} ${hour}:${parts.minute}`;
}

function fmtMoney(n) {
  const v = num(n);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function renderHtml(data) {
  const tz = data?.tenantTimeZone || DEFAULT_TENANT_TIMEZONE;
  const groupsHtml = (data.groups || []).map(g => {
    const rowsHtml = g.rows.map(r => `
      <tr>
        <td>${escapeHtml(r.customer)}</td>
        <td>${escapeHtml(fmtDateTimeShort(r.bookingDate, tz))}</td>
        <td>${escapeHtml(fmtDateTimeShort(r.collectionDate, tz))}</td>
        <td>${escapeHtml(fmtDateTimeShort(r.returnDate, tz))}</td>
        <td>${escapeHtml(r.reservationNumber || r.externalRef || '-')}</td>
        <td style="text-align:right">${fmtMoney(r.value)}</td>
      </tr>
    `).join('');
    return `
      <tr class="group-header"><td colspan="6">${escapeHtml(g.locationName)} (${escapeHtml(g.locationCode)})</td></tr>
      ${rowsHtml}
      <tr class="group-subtotal"><td colspan="5" style="text-align:right">Subtotal</td><td style="text-align:right">${fmtMoney(g.subtotal)}</td></tr>
    `;
  }).join('');

  return `
    <h2>Pre-Paid Reservations Report</h2>
    <p>Period: ${escapeHtml(data.range?.label || '-')} · ${data.count} reservations · Total: $${fmtMoney(data.grandTotal)}</p>
    <table class="report-table">
      <thead>
        <tr>
          <th>Customer</th>
          <th>Booking Date</th>
          <th>Collection</th>
          <th>Return</th>
          <th>Res No</th>
          <th style="text-align:right">Value</th>
        </tr>
      </thead>
      <tbody>
        ${groupsHtml}
        <tr class="grand-total"><td colspan="5" style="text-align:right"><strong>Totals All Branches</strong></td><td style="text-align:right"><strong>${fmtMoney(data.grandTotal)}</strong></td></tr>
      </tbody>
    </table>
  `;
}

// ---------------------------------------------------------------------------
// Excel spec builder
// ---------------------------------------------------------------------------

export function buildExcelSpec(data) {
  const tz = data?.tenantTimeZone || DEFAULT_TENANT_TIMEZONE;
  const sheets = [];
  const rows = [];

  rows.push(['Pre-Paid Reservations Report']);
  rows.push([`Period: ${data.range?.label || '-'}`]);
  rows.push([]);
  rows.push(['Customer', 'Booking Date', 'Collection', 'Return', 'Res No', 'Value']);

  for (const g of (data.groups || [])) {
    rows.push([`${g.locationName} (${g.locationCode})`]);
    for (const r of g.rows) {
      rows.push([
        r.customer,
        fmtDateTimeShort(r.bookingDate, tz),
        fmtDateTimeShort(r.collectionDate, tz),
        fmtDateTimeShort(r.returnDate, tz),
        r.reservationNumber || r.externalRef || '-',
        num(r.value),
      ]);
    }
    rows.push(['', '', '', '', 'Subtotal', g.subtotal]);
    rows.push([]);
  }
  rows.push(['', '', '', '', 'Totals All Branches', data.grandTotal]);

  sheets.push({ name: 'Pre-Paid', rows });
  return { sheets };
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

registerReport({
  slug: 'pre-paid-reservations',
  title: 'Pre-Paid Reservations',
  category: 'OPERATIONS',
  icon: 'card',
  description: 'TL franchise pre-paid bookings — monthly recap by location',
  computeData,
  renderHtml,
  buildExcelSpec,
  roles: ['ADMIN', 'OPS', 'SUPER_ADMIN'],
});
