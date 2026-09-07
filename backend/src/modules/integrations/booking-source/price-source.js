/**
 * Which price a writeback publishes (2026-09-07).
 *
 * Hector: "para cada integracion que nosotros apuntamos que precio queremos
 * empujar, para que la sede tenga control — si quieren poner precios manual en
 * el sistema de Ride y empujarlos lo pueden hacer, o si quieren que market
 * intelligence lo haga de igual manera".
 *
 * Two sources, chosen per SEDE and per INTEGRATION:
 *
 *   MANUAL — the base rate plus only the per-date overrides a PERSON entered in
 *            the Rates UI (holiday and event surge pricing). Market
 *            Intelligence never reaches the partner's portal.
 *   MARKET — the base rate plus EVERY per-date override, MI's auto-applied
 *            prices included.
 *
 * The hard half already exists: RateDailyPrice.source records authorship
 * ('MARKET_A' = written by the MI auto-apply engine, null = operator-authored,
 * which is why the engine only ever cleans up its own rows). Nothing new has to
 * be tracked — the writebacks simply have to start reading it.
 *
 * Default MANUAL: a sede that never opens the screen publishes what a human
 * typed. Letting MI write into somebody else's pricing system is a decision
 * that should be made on purpose, not inherited from a default.
 *
 * NOT affected: stop sales sit ABOVE both sources (a class closed in Ride is
 * closed on the portal at STOP_SALE_DAILY regardless of where the price came
 * from) — see stop-sale-closures.js.
 */

/** RateDailyPrice.source written by the Market Intelligence auto-apply engine. */
export const MARKET_AUTHOR = 'MARKET_A';

export const PRICE_SOURCES = Object.freeze({ MANUAL: 'MANUAL', MARKET: 'MARKET' });

/** Unknown / absent → MANUAL. Never throws: this decides a money write. */
export function normalizePriceSource(value) {
  const raw = String(value || '').trim().toUpperCase();
  return PRICE_SOURCES[raw] || PRICE_SOURCES.MANUAL;
}

/**
 * The sede's choice for one integration. Best-effort — a query failure falls
 * back to MANUAL, the posture that cannot surprise anybody: it publishes the
 * rate a person set.
 */
export async function resolvePriceSource(db, { tenantId, locationId, provider } = {}) {
  if (!db?.integrationPricePolicy?.findUnique || !tenantId || !locationId || !provider) {
    return PRICE_SOURCES.MANUAL;
  }
  const row = await db.integrationPricePolicy.findUnique({
    where: {
      tenantId_locationId_provider: {
        tenantId,
        locationId,
        provider: String(provider).toUpperCase(),
      },
    },
    select: { priceSource: true },
  }).catch(() => null);
  return normalizePriceSource(row?.priceSource);
}

/**
 * Per-date overrides for a window, honouring the sede's choice.
 *
 * `pairs` are the (rateId, vehicleTypeId) tuples the caller already resolved
 * for its classes — the same key the booking engine uses, so a writeback
 * publishes exactly what RFM itself would have quoted on that date.
 *
 * Returns Map<'rateId:vehicleTypeId', Map<'YYYY-MM-DD', number>>. `from`
 * inclusive, `to` EXCLUSIVE, matching every other window in this folder.
 *
 * The MANUAL filter is written as an explicit OR on null rather than a bare
 * `not` — an operator-authored row carries source = NULL, and a SQL `<>`
 * comparison against NULL is not true, so the obvious spelling would silently
 * drop precisely the rows MANUAL exists to publish.
 */
export async function loadDailyOverrides(db, { pairs = [], from, to, priceSource } = {}) {
  const out = new Map();
  if (!db?.rateDailyPrice?.findMany || !pairs.length || !from || !to) return out;

  const manual = normalizePriceSource(priceSource) === PRICE_SOURCES.MANUAL;
  const rows = await db.rateDailyPrice.findMany({
    where: {
      date: { gte: new Date(from), lt: new Date(to) },
      AND: [
        { OR: pairs.map((p) => ({ rateId: p.rateId, vehicleTypeId: p.vehicleTypeId })) },
        ...(manual ? [{ OR: [{ source: null }, { source: { not: MARKET_AUTHOR } }] }] : []),
      ],
    },
    select: { rateId: true, vehicleTypeId: true, date: true, daily: true, source: true },
  }).catch(() => []);

  for (const row of rows) {
    const daily = Number(row.daily);
    if (!Number.isFinite(daily) || daily <= 0) continue;
    const key = `${row.rateId}:${row.vehicleTypeId}`;
    if (!out.has(key)) out.set(key, new Map());
    out.get(key).set(new Date(row.date).toISOString().slice(0, 10), Math.round((daily + Number.EPSILON) * 100) / 100);
  }
  return out;
}

/** Pure: the effective daily for a pair on a date — override wins, base backs it. */
export function effectiveDaily(overrides, pairKey, isoDate, baseDaily) {
  const byDate = overrides?.get?.(pairKey);
  if (byDate && byDate.has(isoDate)) return byDate.get(isoDate);
  const base = Number(baseDaily);
  return Number.isFinite(base) && base > 0 ? Math.round((base + Number.EPSILON) * 100) / 100 : null;
}
