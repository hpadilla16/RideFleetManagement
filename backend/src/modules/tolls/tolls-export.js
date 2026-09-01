/**
 * CSV export for the toll review queue (Tolls redesign A, 2026-08-28).
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the export matches the screen. This
 * repo has twice shipped exports that ignored the on-screen filters (see the
 * apiDownload note in frontend/src/lib/client.js — "the screen and the
 * spreadsheet disagreed, and the spreadsheet is the one people forward").
 * So the list `where` is built HERE, once, as a pure function, and
 * `getDashboard` consumes the SAME builder. An export filter cannot drift from
 * the queue filter without the drift being visible in this one file.
 *
 * Pure module: no prisma import, so the tests run without a DB.
 */

import { queueWhere, TOLL_QUEUE_KEYS } from './tolls-queue-counts.js';
import { scopeAllowedLocationIds } from '../../lib/tenant-scope.js';

/** Mirror of tolls.service.js tenantWhereForScope — tenant fail-closed is the route's job (scopeFor). */
function tenantWhere(scope = {}) {
  return scope?.tenantId ? { tenantId: scope.tenantId } : {};
}

/**
 * Mirror of tollLocationWhere in tolls.service.js (kept there for the many
 * call sites; duplicated here so this module stays prisma-free). A toll's only
 * reliable location link is its matched vehicle's home location; unmatched
 * rows are hidden from location-scoped callers — fail-closed.
 */
function locationWhere(scope = {}) {
  const ids = scopeAllowedLocationIds(scope);
  if (!ids) return {};
  return { vehicle: { is: { homeLocationId: { in: ids } } } };
}

/**
 * The list `where` for the review queue — the ONE definition shared by
 * `getDashboard` (screen) and the CSV export (spreadsheet).
 * Filters: { q, status, needsReview, reservationId }.
 */
export function buildTollListWhere(scope = {}, filters = {}) {
  const search = String(filters.q || '').trim();
  const searchFilter = search ? {
    OR: [
      { location: { contains: search, mode: 'insensitive' } },
      { plateRaw: { contains: search, mode: 'insensitive' } },
      { tagRaw: { contains: search, mode: 'insensitive' } },
      { selloRaw: { contains: search, mode: 'insensitive' } },
      { reservation: { reservationNumber: { contains: search, mode: 'insensitive' } } },
      { vehicle: { internalNumber: { contains: search, mode: 'insensitive' } } }
    ]
  } : {};

  return {
    ...tenantWhere(scope),
    ...locationWhere(scope),
    ...(filters.status ? { status: String(filters.status).toUpperCase() } : {}),
    ...(filters.needsReview === true ? { needsReview: true } : {}),
    ...(filters.reservationId ? { reservationId: String(filters.reservationId) } : {}),
    ...searchFilter
  };
}

/**
 * The export `where`: the list where AND-ed with the active queue-view
 * fragment (ALL / AUTO_MATCHED / NEEDS_REVIEW / ...), exactly like
 * countQueues does — AND-ing keeps the search OR from colliding with the
 * queue fragment's own OR.
 */
export function buildTollExportWhere(scope = {}, filters = {}) {
  const base = buildTollListWhere(scope, filters);
  const view = String(filters.view || 'ALL').toUpperCase();
  const key = TOLL_QUEUE_KEYS.includes(view) ? view : 'ALL';
  const fragment = queueWhere(key);
  return Object.keys(fragment).length ? { AND: [base, fragment] } : base;
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const TOLL_EXPORT_COLUMNS = [
  'transactionAt', 'location', 'lane', 'direction', 'amount',
  'plateRaw', 'tagRaw', 'selloRaw',
  'vehicleInternalNumber', 'vehiclePlate',
  'reservationNumber', 'customer',
  'status', 'billingStatus', 'needsReview',
  'matchConfidence', 'matchReason', 'reviewNotes'
];

function customerName(reservation) {
  const c = reservation?.customer;
  if (!c) return '';
  return [c.firstName, c.lastName].filter(Boolean).join(' ');
}

/**
 * Serialize raw prisma rows (with vehicle / reservation.customer /
 * assignments includes) into the CSV. matchReason keeps its raw scoring
 * tokens on purpose: this is a data export for spreadsheets and support
 * calls, not the queue UI (which renders the human chip map instead).
 */
export function tollsToCsv(rows = []) {
  const lines = [TOLL_EXPORT_COLUMNS.join(',')];
  for (const row of Array.isArray(rows) ? rows : []) {
    const latestAssignment = Array.isArray(row.assignments) && row.assignments.length ? row.assignments[0] : null;
    const reservation = row.reservation || latestAssignment?.reservation || null;
    lines.push([
      row.transactionAt instanceof Date ? row.transactionAt.toISOString() : (row.transactionAt || ''),
      row.location || '',
      row.lane || '',
      row.direction || '',
      Number.isFinite(Number(row.amount)) ? Number(row.amount).toFixed(2) : '',
      row.plateRaw || '',
      row.tagRaw || '',
      row.selloRaw || '',
      row.vehicle?.internalNumber || '',
      row.vehicle?.plate || '',
      reservation?.reservationNumber || '',
      customerName(row.reservation),
      row.status || '',
      row.billingStatus || '',
      row.needsReview ? 'true' : 'false',
      row.matchConfidence == null ? '' : Number(row.matchConfidence),
      latestAssignment?.matchReason || '',
      row.reviewNotes || ''
    ].map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

/** Filename mirrors the active view so a forwarded file says what it holds. */
export function tollExportFilename(filters = {}, now = new Date()) {
  const view = String(filters.view || 'ALL').toUpperCase();
  const key = TOLL_QUEUE_KEYS.includes(view) ? view : 'ALL';
  const stamp = now.toISOString().slice(0, 10);
  return `tolls-${key.toLowerCase().replace(/_/g, '-')}-${stamp}.csv`;
}

/**
 * Export cap. Deliberately far past the screen's 200-row window — reaching the
 * rest of the queue is the point of the export — but bounded so one click
 * cannot stream an unbounded table through the proxy.
 */
export const TOLL_EXPORT_MAX_ROWS = 5000;
