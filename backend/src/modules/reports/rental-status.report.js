/**
 * Rental Status — Round 27 (2026-05-23).
 *
 * Right-now ops snapshot of every active rental. Pure current-state view —
 * no date-range parameter, no time-series. The report answers "what's
 * happening with my fleet right now?".
 *
 *   GET /api/reports/rental-status?locationId=
 *     Returns { asOf, callouts, statusMix, groups[], totalActive, filters }
 *
 *   GET /api/reports/rental-status/group?group=<key>&locationId=<?>
 *     Drill-down for a single status group (returns the full reservation list
 *     for that group with all the same fields as the main payload).
 *
 * Status buckets (rules apply against `now` and `today` local-to-server):
 *
 *   OVERDUE           — CHECKED_OUT and returnAt < today
 *   DUE_TODAY         — CHECKED_OUT and returnAt ∈ [today, tomorrow)
 *   CURRENTLY_OUT     — CHECKED_OUT and returnAt >= tomorrow
 *   UNPAID_AT_CHECKIN — CHECKED_IN_UNPAID
 *   PICKING_UP_TODAY  — NEW/CONFIRMED and pickupAt ∈ [today, tomorrow)
 *
 * Reservations in NEW/CONFIRMED with pickupAt > today are NOT shown — they're
 * not part of the triage (forecast page handles upcoming inventory). Same for
 * NO_SHOW / CANCELLED — terminal states, not active.
 */

import { registerReport } from './reports-v2.routes.js';

const ACTIVE_STATUSES = ['NEW', 'CONFIRMED', 'CHECKED_OUT', 'CHECKED_IN_UNPAID'];

const DAY_MS = 24 * 60 * 60 * 1000;

// Group definitions in triage order (highest urgency first).
const GROUP_ORDER = [
  { key: 'OVERDUE',           label: 'Overdue',           tone: 'danger'  },
  { key: 'UNPAID_AT_CHECKIN', label: 'Unpaid at checkin', tone: 'danger'  },
  { key: 'DUE_TODAY',         label: 'Due back today',    tone: 'warning' },
  { key: 'PICKING_UP_TODAY',  label: 'Picking up today',  tone: 'info'    },
  { key: 'CURRENTLY_OUT',     label: 'Currently out',     tone: 'neutral' },
];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function isoDay(d) { return d.toISOString().slice(0, 10); }

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(d) { return `${WD[d.getDay()]} ${MO[d.getMonth()]} ${d.getDate()}`; }
function timeLabel(d) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = ((h + 11) % 12) + 1;
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm}${ap}`;
}

function diffDaysFromNow(target, today) {
  // Positive = future, negative = past, 0 = today
  return Math.round((startOfDay(target) - today) / DAY_MS);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

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

// ---------------------------------------------------------------------------
// Row formatter — turn a prisma Reservation into the wire-format row
// ---------------------------------------------------------------------------

function formatRow(r, today) {
  const pickup = new Date(r.pickupAt);
  const ret = new Date(r.returnAt);
  const daysFromPickup = diffDaysFromNow(pickup, today);
  const daysFromReturn = diffDaysFromNow(ret, today);

  return {
    id: r.id,
    reservationNumber: r.reservationNumber,
    status: r.status,
    pickupAt: r.pickupAt,
    returnAt: r.returnAt,
    pickupLabel: `${dayLabel(pickup)} · ${timeLabel(pickup)}`,
    returnLabel: `${dayLabel(ret)} · ${timeLabel(ret)}`,
    // Negative = days past return, positive = days until return
    daysFromPickup,
    daysFromReturn,
    customerName: r.customer
      ? `${r.customer.firstName || ''} ${r.customer.lastName || ''}`.trim() || null
      : null,
    customerPhone: r.customer?.phone || null,
    vehicle: r.vehicle
      ? {
          plate: r.vehicle.plate || null,
          label: [r.vehicle.year, r.vehicle.make, r.vehicle.model].filter(Boolean).join(' ') || null,
        }
      : null,
    vehicleType: r.vehicleType?.name || null,
    pickupLocation: r.pickupLocation?.name || null,
    agreementNumber: r.rentalAgreement?.agreementNumber || null,
    balance: r.rentalAgreement?.balance != null ? num(r.rentalAgreement.balance) : 0,
  };
}

// ---------------------------------------------------------------------------
// Bucket logic
// ---------------------------------------------------------------------------

/**
 * Pure function: bucket a list of prisma-shaped reservations into the 5 groups,
 * given the "now" timestamp. Exported for unit testing without prisma.
 */
function bucketReservations(reservations, asOf = new Date()) {
  const today = startOfDay(asOf);
  const tomorrow = addDays(today, 1);

  const buckets = {
    OVERDUE: [],
    UNPAID_AT_CHECKIN: [],
    DUE_TODAY: [],
    PICKING_UP_TODAY: [],
    CURRENTLY_OUT: [],
  };

  for (const r of reservations) {
    const pickup = new Date(r.pickupAt);
    const ret = new Date(r.returnAt);

    if (r.status === 'CHECKED_OUT') {
      if (ret < today) buckets.OVERDUE.push(formatRow(r, today));
      else if (ret < tomorrow) buckets.DUE_TODAY.push(formatRow(r, today));
      else buckets.CURRENTLY_OUT.push(formatRow(r, today));
    } else if (r.status === 'CHECKED_IN_UNPAID') {
      buckets.UNPAID_AT_CHECKIN.push(formatRow(r, today));
    } else if (r.status === 'NEW' || r.status === 'CONFIRMED') {
      if (pickup >= today && pickup < tomorrow) {
        buckets.PICKING_UP_TODAY.push(formatRow(r, today));
      }
    }
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Main computeData
// ---------------------------------------------------------------------------

async function computeData({ tenantId, query }, deps = {}) {
  const prisma = deps.prisma || (await resolveDefaultPrisma());
  if (!tenantId) throw new Error('tenantId required');

  const locationId = (query && query.locationId) || null;
  const asOf = (deps && deps.now) || new Date();

  const where = {
    tenantId,
    status: { in: ACTIVE_STATUSES },
  };
  if (locationId) where.pickupLocationId = locationId;

  const reservations = await prisma.reservation.findMany({
    where,
    select: {
      id: true, reservationNumber: true, status: true,
      pickupAt: true, returnAt: true,
      customer:       { select: { firstName: true, lastName: true, phone: true } },
      vehicle:        { select: { plate: true, year: true, make: true, model: true } },
      vehicleType:    { select: { id: true, name: true, code: true } },
      pickupLocation: { select: { id: true, name: true } },
      rentalAgreement:{ select: { id: true, agreementNumber: true, balance: true } },
    },
    orderBy: [{ returnAt: 'asc' }, { pickupAt: 'asc' }],
  });

  const buckets = bucketReservations(reservations, asOf);

  // Group list in triage order, surfacing empty groups via a count=0 entry that
  // the UI can choose to render or skip.
  const groups = GROUP_ORDER.map((g) => ({
    key: g.key,
    label: g.label,
    tone: g.tone,
    reservations: buckets[g.key],
    count: buckets[g.key].length,
  }));

  const callouts = {
    currentlyOut:     buckets.OVERDUE.length + buckets.DUE_TODAY.length + buckets.CURRENTLY_OUT.length,
    overdue:          buckets.OVERDUE.length,
    dueBackToday:     buckets.DUE_TODAY.length,
    pickingUpToday:   buckets.PICKING_UP_TODAY.length,
    unpaidAtCheckin:  buckets.UNPAID_AT_CHECKIN.length,
  };

  // Status mix — Open / Out / Returned (Lost not shown; it's terminal)
  const statusMix = { OPEN: 0, OUT: 0, RETURNED: 0 };
  for (const r of reservations) {
    if (r.status === 'NEW' || r.status === 'CONFIRMED') statusMix.OPEN += 1;
    else if (r.status === 'CHECKED_OUT')                statusMix.OUT += 1;
    else if (r.status === 'CHECKED_IN_UNPAID')          statusMix.RETURNED += 1;
  }

  return {
    asOf: asOf.toISOString(),
    asOfLabel: `${dayLabel(asOf)} · ${timeLabel(asOf)}`,
    callouts,
    statusMix,
    groups,
    totalActive: reservations.length,
    filters: { locationId },
  };
}

// ---------------------------------------------------------------------------
// Drill-down — single group (returns the full list, useful for an "expand"
// button in the UI if a group has hundreds of rows that we truncated)
// ---------------------------------------------------------------------------

async function groupDrillDownHandler(req, res, { tenantId }) {
  const groupKey = (req.query?.group || '').toString().toUpperCase();
  const validGroups = new Set(GROUP_ORDER.map((g) => g.key));
  if (!validGroups.has(groupKey)) {
    return res.status(400).json({ error: `group must be one of ${Array.from(validGroups).join(', ')}` });
  }

  const out = await computeData(
    { tenantId, query: { locationId: req.query?.locationId || null } },
    {},
  );
  const group = out.groups.find((g) => g.key === groupKey);
  return res.json({
    asOf: out.asOf,
    group: group ? { key: group.key, label: group.label, tone: group.tone, count: group.count } : null,
    reservations: group?.reservations || [],
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
  const { callouts, groups, asOfLabel, statusMix, totalActive } = data;

  const strip = `<div class="strip">
    <div class="strip-card"><div class="strip-label">Currently out</div><div class="strip-value">${callouts.currentlyOut}</div></div>
    <div class="strip-card heat-red"><div class="strip-label">Overdue</div><div class="strip-value">${callouts.overdue}</div></div>
    <div class="strip-card heat-amber"><div class="strip-label">Due back today</div><div class="strip-value">${callouts.dueBackToday}</div></div>
    <div class="strip-card"><div class="strip-label">Picking up today</div><div class="strip-value">${callouts.pickingUpToday}</div></div>
    <div class="strip-card heat-red"><div class="strip-label">Unpaid at checkin</div><div class="strip-value">${callouts.unpaidAtCheckin}</div></div>
  </div>`;

  let body = `${strip}
    <p style="font-size:10px;color:#5F5E5A;margin:0 0 12px">As of ${escapeHtml(asOfLabel)} · ${totalActive} active reservations · ${statusMix.OPEN} open · ${statusMix.OUT} out · ${statusMix.RETURNED} returned-unpaid</p>`;

  for (const g of groups) {
    if (g.count === 0) continue;
    body += `<h3>${escapeHtml(g.label.toUpperCase())} · ${g.count}</h3>
      <table style="font-size:10px"><thead><tr>
        <th style="text-align:left">Customer</th>
        <th style="text-align:left">Reservation</th>
        <th style="text-align:left">Vehicle</th>
        <th style="text-align:left">Pickup</th>
        <th style="text-align:left">Return / Due</th>
        <th class="num">Balance</th>
      </tr></thead><tbody>`;
    for (const r of g.reservations) {
      const vehLabel = r.vehicle?.plate ? `[${r.vehicle.plate}] ${r.vehicle.label || ''}` : (r.vehicle?.label || r.vehicleType || '');
      const dueNote = g.key === 'OVERDUE' ? ` (${Math.abs(r.daysFromReturn)} day${Math.abs(r.daysFromReturn) === 1 ? '' : 's'} late)`
                    : g.key === 'CURRENTLY_OUT' && r.daysFromReturn > 0 ? ` (${r.daysFromReturn} day${r.daysFromReturn === 1 ? '' : 's'} left)`
                    : '';
      body += `<tr>
        <td>${escapeHtml(r.customerName || '—')}</td>
        <td>${escapeHtml(r.reservationNumber || r.id)}</td>
        <td>${escapeHtml(vehLabel)}</td>
        <td>${escapeHtml(r.pickupLabel)}</td>
        <td>${escapeHtml(r.returnLabel)}${escapeHtml(dueNote)}</td>
        <td class="num">${r.balance > 0 ? money(r.balance) : ''}</td>
      </tr>`;
    }
    body += `</tbody></table>`;
  }

  if (groups.every((g) => g.count === 0)) {
    body += `<p style="text-align:center;color:#5F5E5A;font-size:11px;padding:30px">No active rentals to triage.</p>`;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Excel — flat table with group column for sorting
// ---------------------------------------------------------------------------

function buildExcelSpec(data) {
  const { groups, asOfLabel } = data;
  const title = 'Rental Status';
  const subtitle = `As of ${asOfLabel}`;

  const columns = [
    { header: 'Group',            key: 'group',          width: 22 },
    { header: 'Customer',         key: 'customer',       width: 22 },
    { header: 'Reservation',      key: 'reservation',    width: 14 },
    { header: 'Status',           key: 'status',         width: 14 },
    { header: 'Vehicle plate',    key: 'plate',          width: 12 },
    { header: 'Vehicle',          key: 'vehicle',        width: 22 },
    { header: 'Type',             key: 'type',           width: 12 },
    { header: 'Pickup',           key: 'pickup',         width: 22 },
    { header: 'Return / Due',     key: 'return',         width: 22 },
    { header: 'Days from return', key: 'daysFromReturn', width: 14, type: 'integer' },
    { header: 'Balance',          key: 'balance',        width: 12, type: 'currency' },
    { header: 'Location',         key: 'location',       width: 18 },
    { header: 'Phone',            key: 'phone',          width: 16 },
  ];

  const rows = [];
  for (const g of groups) {
    for (const r of g.reservations) {
      rows.push({
        group: g.label,
        customer: r.customerName || '',
        reservation: r.reservationNumber || r.id,
        status: r.status,
        plate: r.vehicle?.plate || '',
        vehicle: r.vehicle?.label || '',
        type: r.vehicleType || '',
        pickup: r.pickupLabel,
        return: r.returnLabel,
        daysFromReturn: r.daysFromReturn,
        balance: r.balance || 0,
        location: r.pickupLocation || '',
        phone: r.customerPhone || '',
      });
    }
  }

  return {
    title,
    subtitle,
    sheets: [{
      name: 'Rental Status',
      bannerRows: [[title], [subtitle]],
      columns,
      rows,
    }],
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

registerReport({
  slug: 'rental-status',
  title: 'Rental Status',
  computeData,
  renderHtml,
  buildExcelSpec,
  subRoutes: [
    { path: '/group', method: 'get', handler: groupDrillDownHandler },
  ],
});

export const _rentalStatusInternal = {
  computeData,
  groupDrillDownHandler,
  bucketReservations,
  formatRow,
  GROUP_ORDER,
  ACTIVE_STATUSES,
  startOfDay,
  addDays,
  isoDay,
  dayLabel,
  diffDaysFromNow,
};
