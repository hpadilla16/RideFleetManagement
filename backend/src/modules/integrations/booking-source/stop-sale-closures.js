/**
 * Ride stop sales → outbound writeback closures (2026-08-06).
 *
 * Hector: "esa regla del stop sale aplica para todas las integraciones que
 * tienen writeback y todas que anadimos el writeback". A class closed in Ride
 * (VehicleClassStopSale) must close on every franchise portal RFM writes rates
 * to. None of those portals expose an availability API, so the closure is
 * expressed the only way a rate feed can: price the class out — daily 999.99,
 * the other tiers by each integration's own formula.
 *
 * This module is the ONE place that reads stop sales for writeback purposes,
 * so every current integration (MEX, Economy) and every future one answers
 * the same question the same way: is (class, date) closed?
 *
 * Semantics, shared by all consumers:
 *   - isActive rows only; both endpoints INCLUSIVE (a stop sale Aug 10–12
 *     closes the 10th, 11th and 12th) — matching the booking engine's own
 *     overlap check (stop-sale-overlap.js).
 *   - Keyed by the RFM VehicleType.code; integrations map to their portal's
 *     class codes with whatever mapping they already use for prices.
 *   - A closure BEATS every price source and bypasses delta guards — holding
 *     a close-out for review would leave a closed class selling overnight.
 */

/** The close-out daily. Weekly/monthly are each integration's formula over it. */
export const STOP_SALE_DAILY = 999.99;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Load the tenant's closures for a window as Map<CLASSCODE, Set<'YYYY-MM-DD'>>.
 * `from` inclusive, `to` EXCLUSIVE (matching the callers' window convention).
 * Best-effort: a query failure returns an empty map — the caller keeps pushing
 * prices, and the closure lands on the next run.
 */
export async function loadStopSaleClosures(db, { tenantId, from, to }) {
  const out = new Map();
  if (!db?.vehicleClassStopSale?.findMany || !tenantId || !from || !to) return out;
  const fromDate = new Date(from);
  const toDate = new Date(to);
  const rows = await db.vehicleClassStopSale.findMany({
    where: {
      tenantId,
      isActive: true,
      startDate: { lt: toDate },
      endDate: { gte: fromDate },
    },
    select: { startDate: true, endDate: true, vehicleType: { select: { code: true } } },
  }).catch(() => []);

  for (const row of rows) {
    const code = String(row.vehicleType?.code || '').trim().toUpperCase();
    if (!code) continue;
    if (!out.has(code)) out.set(code, new Set());
    const days = out.get(code);
    const startIso = new Date(row.startDate).toISOString().slice(0, 10);
    const endIso = new Date(row.endDate).toISOString().slice(0, 10);
    for (let d = new Date(fromDate); d < toDate; d = new Date(d.getTime() + DAY_MS)) {
      const iso = d.toISOString().slice(0, 10);
      if (iso >= startIso && iso <= endIso) days.add(iso);
    }
  }
  return out;
}

/** Pure: is (classCode, isoDate) closed in the loaded map? */
export function isClassClosedOn(closures, classCode, isoDate) {
  if (!closures || typeof closures.get !== 'function') return false;
  const days = closures.get(String(classCode || '').trim().toUpperCase());
  return !!days && days.has(String(isoDate));
}
