/**
 * Pure helpers for stop-sale date-range math. No prisma, no logger - safe to
 * import from anywhere (including unit tests) without bootstrapping the DB.
 */

export function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Does a stop-sale's active window overlap the requested rental window?
 * Overlap uses half-open intervals: a stop-sale [S, E) overlaps a rental
 * [P, R) iff S < R AND E > P. Inactive stop-sales never overlap.
 */
export function isStopSaleOverlapping(stopSale, pickupAt, returnAt) {
  if (!stopSale?.isActive) return false;
  const pickup = toDate(pickupAt);
  const back = toDate(returnAt);
  const start = toDate(stopSale?.startDate);
  const end = toDate(stopSale?.endDate);
  if (!pickup || !back || !start || !end) return false;
  return start < back && end > pickup;
}
