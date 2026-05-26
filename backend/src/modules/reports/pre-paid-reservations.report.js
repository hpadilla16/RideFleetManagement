/**
 * Pre-Paid Reservations report — 2026-05-25
 *
 * Lists all reservations imported from TL International (the franchise pre-pay
 * channel) for a given year + month, grouped by pickup location. Pre-paid
 * means TL collected the money upfront when the customer booked through the
 * affiliate / OTA. We're just executing the pickup + return at the counter.
 *
 *   GET /api/reports/pre-paid-reservations?year=YYYY&month=MM
 *     Returns { range, groups: [{ locationCode, locationName, rows[], subtotal }],
 *               grandTotal, count, currency, filters }
 *
 * Source: ExternalReservation rows where sourceSystem = 'TL_INTERNATIONAL'.
 * We INCLUDE rows in any promotionStatus (PENDING / MANUAL_REVIEW /
 * AUTO_PROMOTED / PROMOTED) because the BOOKING exists in TL regardless of
 * whether we've imported it into our own Reservations table yet — the report
 * is about money TL has already collected, not about our internal workflow.
 *
 * We exclude REJECTED rows (those are bookings we explicitly chose not to
 * import — e.g. duplicates, cancelled, etc.).
 *
 * Filter semantics:
 *   - year + month gate on `pickupAt` (collection date — when the customer
 *     picks up the car). This matches the mockup label "COLLECTION" and is
 *     how rental ops typically tracks revenue: by service date, not booking
 *     date. Drop the year/month filter to see everything ever imported.
 *
 * Column mapping (mockup → backend field):
 *   CUSTOMER     → customerFirstName + ' ' + customerLastName
 *   BOOKING DATE → firstSeenAt (when we first saw it from TL — approximates
 *                  TL's "Date" column. TL's actual booking date lives in
 *                  rawJson and varies by channel; firstSeenAt is reliable.)
 *   COLLECTION   → pickupAt
 *   RETURN       → dropoffAt
 *   RES NO       → externalRef (ZE…)
 *   VALUE        → totalAmount
 *
 * Grouping: by pickupLocation code. "San Juan Airport (SJUA01)" → group key
 * SJUA01. Locations group label uses our LocationCodeMap → Location.name when
 * available, else falls back to the raw code.
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

function parseYearMonth(params) {
  const fallback = defaultYearMonth();
  const y = parseInt(params?.year, 10);
  const m = parseInt(params?.month, 10);
  const year  = Number.isFinite(y) && y >= 2020 && y <= 2100 ? y : fallback.year;
  const month = Number.isFinite(m) && m >= 1 && m <= 12 ? m : fallback.month;
  return { year, month };
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
  const tenantTz = await resolveTenantTimeZone(params.tenantId);
  const { start, end } = monthBoundsInTz(year, month, tenantTz);

  const rows = await prisma.externalReservation.findMany({
    where: {
      tenantId: params.tenantId,
      sourceSystem: 'TL_INTERNATIONAL',
      promotionStatus: { not: 'REJECTED' },
      pickupAt: { gte: start, lt: end },
    },
    orderBy: [{ pickupLocation: 'asc' }, { pickupAt: 'asc' }],
    select: {
      id: true,
      externalRef: true,
      customerFirstName: true,
      customerLastName: true,
      pickupAt: true,
      dropoffAt: true,
      pickupLocation: true,
      totalAmount: true,
      currency: true,
      firstSeenAt: true,
      promotionStatus: true,
    },
  });

  // Resolve location codes → friendly names via LocationCodeMap (best-effort).
  const codes = Array.from(new Set(rows.map(r => extractLocationCode(r.pickupLocation))));
  const locMaps = codes.length
    ? await prisma.locationCodeMap.findMany({
        where: { tenantId: params.tenantId, externalCode: { in: codes } },
        select: { externalCode: true, location: { select: { name: true } } },
      }).catch(() => [])
    : [];
  const codeToName = new Map();
  for (const m of locMaps) {
    if (m.location?.name) codeToName.set(m.externalCode, m.location.name);
  }

  // Group rows by location code.
  const groupMap = new Map();
  for (const r of rows) {
    const code = extractLocationCode(r.pickupLocation);
    if (!groupMap.has(code)) {
      groupMap.set(code, {
        locationCode: code,
        locationName: codeToName.get(code) || code,
        rows: [],
        subtotal: 0,
      });
    }
    const g = groupMap.get(code);
    const value = num(r.totalAmount);
    g.rows.push({
      id: r.id,
      customer: customerName(r),
      bookingDate: r.firstSeenAt,
      collectionDate: r.pickupAt,
      returnDate: r.dropoffAt,
      externalRef: r.externalRef,
      value,
      promotionStatus: r.promotionStatus,
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
  const count = rows.length;

  return {
    range: { year, month, label: fmtRangeLabel(year, month), from: start.toISOString(), to: end.toISOString() },
    groups,
    grandTotal,
    count,
    currency: 'USD',
    tenantTimeZone: tenantTz,
    filters: { year, month },
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
        <td>${escapeHtml(r.externalRef)}</td>
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
        r.externalRef,
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
