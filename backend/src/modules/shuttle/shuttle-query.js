/**
 * Shuttle list + delay-notice decisions, PURE (no prisma, no IO) — 2026-08-07.
 *
 * Extracted so the parts that decide WHO SEES WHAT can be tested without a
 * database. The shuttle integration suite needs embedded postgres and
 * therefore does not run in CI's DB-free step; a scoping regression would
 * have shipped unseen. These are the rules worth guarding:
 *
 *   - the LIVE queue (`open`) is never date-windowed. An open request from
 *     yesterday is still a customer standing at a curb; windowing it would
 *     silently drop them off the banner.
 *   - a locationId filter INTERSECTS the caller's scope, never replaces it.
 *     Asking for a sede outside your list returns nothing — not that sede.
 */

export const OPEN_STATUSES = ['READY', 'VIEWED'];
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

/** Tenant + the caller's own location restriction. Empty list = unscoped. */
export function scopeWhere(scope = {}) {
  const where = {};
  if (scope?.tenantId) where.tenantId = scope.tenantId;
  const locationIds = Array.isArray(scope?.allowedLocationIds) ? scope.allowedLocationIds.filter(Boolean) : [];
  if (locationIds.length) where.locationId = { in: locationIds.map(String) };
  return where;
}

/**
 * The full Prisma query for a list request.
 * @returns {{where, orderBy, take, skip, isLiveQueue, page, pageSize}}
 */
export function buildListQuery(scope = {}, { status = 'open', limit, page, from, to, locationId, now = new Date() } = {}) {
  const where = scopeWhere(scope);
  const wanted = String(status || 'open').toLowerCase();
  const isLiveQueue = wanted === 'open';

  if (isLiveQueue) where.status = { in: OPEN_STATUSES };
  else if (wanted !== 'all') where.status = String(status).toUpperCase();

  if (locationId) {
    const requested = String(locationId);
    const allowed = Array.isArray(scope?.allowedLocationIds) ? scope.allowedLocationIds.filter(Boolean).map(String) : [];
    // Intersect, never widen: a foreign sede yields an impossible filter.
    where.locationId = allowed.length && !allowed.includes(requested) ? { in: [] } : requested;
  }

  if (!isLiveQueue) {
    const fromDate = from ? new Date(from) : new Date(new Date(now).toISOString().slice(0, 10));
    const toDate = to ? new Date(new Date(to).getTime() + DAY_MS) : new Date(fromDate.getTime() + DAY_MS);
    if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime())) {
      where.createdAt = { gte: fromDate, lt: toDate };
    }
  }

  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE));
  const pageNum = Math.max(1, Number(page) || 1);
  return {
    where,
    orderBy: [{ createdAt: isLiveQueue ? 'asc' : 'desc' }],
    take: pageSize,
    skip: (pageNum - 1) * pageSize,
    isLiveQueue,
    page: pageNum,
    pageSize
  };
}

/** One delay-notice log entry. `status` starts SENT and may be downgraded. */
export function buildDelayNotice({ reason = null, etaMinutes = null, to, userId = null, now = new Date() } = {}) {
  const eta = Number(etaMinutes);
  return {
    at: new Date(now).toISOString(),
    byUserId: userId || null,
    reason: String(reason || '').trim() || null,
    etaMinutes: Number.isFinite(eta) && eta > 0 ? eta : null,
    to,
    status: 'SENT'
  };
}

/**
 * Append to the stored log. Garbage (bad JSON, a non-array) is replaced, not
 * thrown on: losing an unreadable log is better than blocking the notice the
 * customer is waiting for.
 */
export function appendNotice(existingJson, notice) {
  let list = [];
  try {
    const parsed = JSON.parse(existingJson || '[]');
    if (Array.isArray(parsed)) list = parsed;
  } catch { list = []; }
  return [...list, notice];
}

/** Mark a previously-logged notice as FAILED after the provider rejected it. */
export function markNoticeFailed(existingJson, notice, error) {
  const list = appendNotice(existingJson, null).filter(Boolean);
  const mine = list.find((n) => n?.at === notice.at && n?.to === notice.to);
  if (mine) {
    mine.status = 'FAILED';
    mine.error = String(error?.message || error || '').slice(0, 200);
  }
  return list;
}
