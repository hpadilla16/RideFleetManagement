/**
 * Per-tenant, per-day rollup table for the dashboard summary endpoint.
 *
 * Why a regular table and not a Postgres MATERIALIZED VIEW:
 *   1. Each tenant computes "today" against its own timezone (see
 *      reservationsService.summary). A single MV with a fixed time bucket
 *      doesn't fit that — you'd need per-tenant rows anyway.
 *   2. A normal table is upsertable per-tenant (we only refresh the
 *      tenants that actually have traffic). REFRESH MATERIALIZED VIEW
 *      always recomputes everything.
 *   3. Easier to test (monkey-patch prisma; no DB needed).
 *
 * Wiring:
 *   - reservationsService.summary() calls readFreshCounters() first.
 *   - On hit, it merges the counts into the existing response shape and
 *     skips the 5 COUNT() queries.
 *   - On miss/stale, it falls back to the live aggregation (existing
 *     code path) and fires-and-forgets refreshCounters() so the next
 *     request hits the table.
 *
 * Freshness:
 *   - DEFAULT_MAX_AGE_MS (5 min) bounds staleness. The Phase 1 cache
 *     layer also caches the summary endpoint at 30s — so the actual
 *     visible staleness is min(30s, 5min) = 30s in steady state.
 *   - When a scheduler is wired up (separate ops decision; see Phase 3
 *     L-2 closeout doc), it can call refreshCounters() proactively
 *     every minute or so, eliminating the on-miss recompute path.
 */

import { prisma } from '../../lib/prisma.js';

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Read the counter row for a tenant on a given day, but only return it
 * if it was refreshed within maxAgeMs. Otherwise treat it as a miss so
 * the caller falls back to the live aggregation.
 */
export async function readFreshCounters({ tenantId, day, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!day) return null;
  try {
    const row = await prisma.reservationDailyCounter.findUnique({
      where: { tenantId_day: { tenantId: tenantId || null, day } }
    });
    if (!row) return null;
    const ageMs = Date.now() - new Date(row.refreshedAt).getTime();
    if (ageMs > maxAgeMs) return null;
    return {
      pickupsToday: row.pickupsToday,
      returnsToday: row.returnsToday,
      checkedOut: row.checkedOut,
      feeAdvisories: row.feeAdvisories,
      noShows: row.noShows,
      refreshedAt: row.refreshedAt,
      ageMs
    };
  } catch (err) {
    // Don't let a counter-table read failure break the dashboard.
    // Caller falls back to live aggregation.
    return null;
  }
}

/**
 * Recompute today's counts for a tenant and upsert into the counter
 * table. Safe to call from a scheduler or fire-and-forget from the
 * summary endpoint when it falls back to the live path.
 *
 * Pass the SAME dayStart/dayEnd window the live summary uses so the
 * stored counts match what summary() would compute live.
 */
export async function refreshCounters({ tenantId, day, dayStart, dayEnd } = {}) {
  if (!day || !dayStart || !dayEnd) return null;
  const where = tenantId ? { tenantId } : {};
  try {
    const [pickupsToday, returnsToday, checkedOut, feeAdvisories, noShows] = await Promise.all([
      prisma.reservation.count({ where: { ...where, pickupAt: { gte: dayStart, lte: dayEnd } } }),
      prisma.reservation.count({ where: { ...where, returnAt: { gte: dayStart, lte: dayEnd } } }),
      prisma.reservation.count({ where: { ...where, status: 'CHECKED_OUT' } }),
      prisma.reservation.count({ where: { ...where, notes: { contains: '[FEE_ADVISORY_OPEN' } } }),
      prisma.reservation.count({ where: { ...where, status: 'NO_SHOW' } })
    ]);

    const data = {
      tenantId: tenantId || null,
      day,
      pickupsToday,
      returnsToday,
      checkedOut,
      feeAdvisories,
      noShows,
      refreshedAt: new Date()
    };

    return await prisma.reservationDailyCounter.upsert({
      where: { tenantId_day: { tenantId: tenantId || null, day } },
      create: data,
      update: {
        pickupsToday: data.pickupsToday,
        returnsToday: data.returnsToday,
        checkedOut: data.checkedOut,
        feeAdvisories: data.feeAdvisories,
        noShows: data.noShows,
        refreshedAt: data.refreshedAt
      }
    });
  } catch (err) {
    // Refresh failure shouldn't poison the request that triggered it.
    // Returning null is enough; the live aggregation already responded.
    return null;
  }
}

/**
 * Fire-and-forget wrapper. Use from the request path when the live
 * aggregation has already responded to the user but we want to populate
 * the counter table for the next request.
 */
export function refreshCountersAsync(args) {
  // Intentionally not awaited.
  refreshCounters(args).catch(() => {});
}
