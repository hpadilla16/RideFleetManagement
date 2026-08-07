/**
 * The toll queue tabs, as ONE definition the database can count.
 *
 * THE BUG THIS EXISTS FOR (Hector, 2026-08-07): "teníamos 19 that needed to be
 * confirmed, le dieron confirm all y entonces salió que ahora son 21".
 *
 * Nothing had gone wrong with the matcher. The tab counts were computed in the
 * browser from `transactions.filter(...)` over the page the API had returned —
 * `take: 200` out of a 3,579-deep queue, ordered `needsReview desc`. Confirming
 * rows removed them from that window, which pulled unseen rows in behind them,
 * and the number went UP. A counter that moves the wrong way when you do work
 * teaches people not to trust the module.
 *
 * So the predicates live here once, in two forms that are asserted against each
 * other: `matches()` for a serialized row, and `queueWhere()` for Prisma. The
 * page can still filter what it has; the COUNT comes from the database.
 *
 * Both computed flags reduce to substrings of reviewNotes, which is what makes
 * this countable at all:
 *   coveredByTollPackage        -> 'covered by prepaid toll package'
 *   dispatchConfirmationRequired-> 'dispatch-confirmation-required'
 */

export const TOLL_PACKAGE_NOTE = 'covered by prepaid toll package';
export const DISPATCH_TOKEN = 'dispatch-confirmation-required';

/** Statuses that count as an automatic, human-free match. */
const AUTO_MATCHED_STATUSES = ['MATCHED', 'BILLED'];

export const TOLL_QUEUE_KEYS = Object.freeze([
  'ALL',
  'AUTO_MATCHED',
  'NEEDS_REVIEW',
  'NO_SUGGESTION',
  'UNMATCHED',
  'DISPATCH_REVIEW',
  'USAGE_ONLY',
  'READY_TO_POST',
]);

const has = (v) => v != null && v !== '';
const contains = (text, needle) => String(text || '').toLowerCase().includes(needle);

/** A row carries a suggestion when a human has something to accept or reject. */
export function hasSuggestion(row = {}) {
  return has(row.reservationId ?? row.reservation?.id)
    || has(row.vehicleId ?? row.vehicle?.id)
    || Number(row.matchConfidence || 0) > 0;
}

export function isCoveredByPackage(row = {}) {
  return contains(row.reviewNotes, TOLL_PACKAGE_NOTE);
}

export function isDispatchReview(row = {}) {
  // Mirrors serializeTransaction: reviewNotes wins, and the latest assignment's
  // matchReason is consulted only when reviewNotes is empty.
  const notes = String(row.reviewNotes || '');
  if (notes) return contains(notes, DISPATCH_TOKEN);
  const latest = Array.isArray(row.assignments) && row.assignments.length ? row.assignments[0] : null;
  return contains(latest?.matchReason, DISPATCH_TOKEN);
}

/** Does a serialized/raw row belong to this queue? */
export function matches(key, row = {}) {
  const reservationId = row.reservationId ?? row.reservation?.id ?? null;
  const needsReview = !!row.needsReview;
  const status = String(row.status || '').toUpperCase();
  const suggestion = hasSuggestion(row);

  switch (key) {
    case 'ALL':
      return true;
    case 'AUTO_MATCHED':
      return has(reservationId) && !needsReview && AUTO_MATCHED_STATUSES.includes(status);
    case 'NEEDS_REVIEW':
      return needsReview && suggestion;
    case 'NO_SUGGESTION':
      // The 3,390 that made International's queue look like a backlog: flagged
      // for review with no match candidate at all — mostly off-rental usage.
      return needsReview && !suggestion;
    case 'UNMATCHED':
      return !has(reservationId) && !(needsReview && suggestion);
    case 'DISPATCH_REVIEW':
      return isDispatchReview(row);
    case 'USAGE_ONLY':
      return isCoveredByPackage(row);
    case 'READY_TO_POST':
      return has(reservationId)
        && String(row.billingStatus || '').toUpperCase() === 'PENDING'
        && !needsReview
        && !isCoveredByPackage(row);
    default:
      return false;
  }
}

const SUGGESTION_OR = [
  { reservationId: { not: null } },
  { vehicleId: { not: null } },
  { matchConfidence: { gt: 0 } },
];

const PACKAGE_WHERE = { reviewNotes: { contains: TOLL_PACKAGE_NOTE, mode: 'insensitive' } };

/**
 * The same predicate as a Prisma where fragment, to be spread onto the caller's
 * scoped base where.
 */
export function queueWhere(key) {
  switch (key) {
    case 'ALL':
      return {};
    case 'AUTO_MATCHED':
      return { reservationId: { not: null }, needsReview: false, status: { in: AUTO_MATCHED_STATUSES } };
    case 'NEEDS_REVIEW':
      return { needsReview: true, OR: SUGGESTION_OR };
    case 'NO_SUGGESTION':
      return {
        needsReview: true,
        reservationId: null,
        vehicleId: null,
        OR: [{ matchConfidence: null }, { matchConfidence: { lte: 0 } }],
      };
    case 'UNMATCHED':
      // reservationId is null here, so AUTO_MATCHED cannot apply and only the
      // needs-review-WITH-suggestion case has to be excluded.
      return {
        reservationId: null,
        NOT: { AND: [{ needsReview: true }, { OR: [{ vehicleId: { not: null } }, { matchConfidence: { gt: 0 } }] }] },
      };
    case 'DISPATCH_REVIEW':
      return {
        OR: [
          { reviewNotes: { contains: DISPATCH_TOKEN, mode: 'insensitive' } },
          {
            AND: [
              { OR: [{ reviewNotes: null }, { reviewNotes: '' }] },
              { assignments: { some: { matchReason: { contains: DISPATCH_TOKEN, mode: 'insensitive' } } } },
            ],
          },
        ],
      };
    case 'USAGE_ONLY':
      return PACKAGE_WHERE;
    case 'READY_TO_POST':
      return {
        reservationId: { not: null },
        billingStatus: 'PENDING',
        needsReview: false,
        NOT: PACKAGE_WHERE,
      };
    default:
      return {};
  }
}

/**
 * Count every queue against the caller's scoped base where.
 *
 * @param {object} db     prisma client (or anything with tollTransaction.count)
 * @param {object} base   the tenant/location/filter where already built by the caller
 * @returns {Promise<Record<string, number>>}
 */
export async function countQueues(db, base = {}) {
  const entries = await Promise.all(TOLL_QUEUE_KEYS.map(async (key) => {
    const fragment = queueWhere(key);
    // AND-ing keeps the caller's own OR (search) from colliding with ours.
    const where = Object.keys(fragment).length ? { AND: [base, fragment] } : base;
    return [key, await db.tollTransaction.count({ where })];
  }));
  return Object.fromEntries(entries);
}
