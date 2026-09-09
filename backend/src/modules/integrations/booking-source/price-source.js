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

/**
 * The GDS-style connection an integration sells on, or null to inherit the
 * sede's. Never guesses: an unrecognised value reads as "not declared" rather
 * than as one of the two, because picking one would re-solve real prices under
 * a formula nobody chose.
 */
export function normalizeConnectionType(value) {
  const v = String(value || '').trim().toUpperCase();
  return v === 'TITANIUM' || v === 'AMADEUS' ? v : null;
}

/** Unknown / absent → MANUAL. Never throws: this decides a money write. */
export function normalizePriceSource(value) {
  const raw = String(value || '').trim().toUpperCase();
  return PRICE_SOURCES[raw] || PRICE_SOURCES.MANUAL;
}

/**
 * The sede's whole posture for one integration, in one read:
 *
 *   ratePushEnabled — does this sede push rates AT ALL for this provider?
 *                     (Hector 2026-09-07: turning off a writeback must not mean
 *                     turning off the reservation sync too.)
 *   priceSource     — if it does, whose prices go out.
 *   explicit        — whether a human has actually chosen, or this is default.
 *
 * Best-effort and FAIL-CLOSED on both axes: an unreadable policy is
 * { ratePushEnabled: false, priceSource: MANUAL }. A missing row is the same,
 * which is what makes a newly mapped sede import reservations immediately while
 * touching nobody's prices until somebody says so.
 *
 * Note the asymmetry with the env gate: the env mode can only ever REMOVE
 * permission (OFF beats an enabled sede), never grant it.
 */
export async function resolvePricePolicy(db, { tenantId, locationId, provider } = {}) {
  const closed = {
    ratePushEnabled: false, priceSource: PRICE_SOURCES.MANUAL,
    connectionType: null, explicit: false,
  };
  if (!db?.integrationPricePolicy?.findUnique || !tenantId || !locationId || !provider) return closed;
  const row = await db.integrationPricePolicy.findUnique({
    where: {
      tenantId_locationId_provider: {
        tenantId,
        locationId,
        provider: String(provider).toUpperCase(),
      },
    },
    select: { priceSource: true, ratePushEnabled: true, connectionType: true },
  }).catch(() => null);
  if (!row) return closed;
  return {
    ratePushEnabled: row.ratePushEnabled === true,
    priceSource: normalizePriceSource(row.priceSource),
    // NULL means "inherit the sede", and null is what the caller must see —
    // substituting a default here would silently claim an integration declared
    // a connection it never did.
    connectionType: normalizeConnectionType(row.connectionType),
    explicit: true,
  };
}

/**
 * Just the source half. Kept as its own export because the loaders only ever
 * need this much, and passing them a whole policy object invites reading the
 * switch in a place that has already decided to run.
 */
export async function resolvePriceSource(db, args = {}) {
  return (await resolvePricePolicy(db, args)).priceSource;
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

/**
 * A function that converts a maintained base rate into the base THIS
 * integration should publish (2026-09-08).
 *
 * Market Intelligence keeps one base per class, back-solved under the sede's
 * single connection type. Titanium compounds tax and brokerage while Amadeus
 * adds them, so that one number reaches two different customer-facing prices.
 * An integration that declares its own connection gets its base re-solved so
 * the SHELF PRICE lands where the strategy aimed, instead of the base merely
 * matching.
 *
 * Returns the identity function whenever nothing should change — no declared
 * connection, same connection as the sede, or no pricing config to convert
 * through. That is the common case and it must cost nothing and alter nothing.
 *
 * Best-effort: a config that cannot be read leaves prices exactly as they are.
 * Publishing an unconverted base is a positioning error; publishing a number
 * derived from a config we failed to load would be a fabrication.
 */
export async function makeConnectionRebaser(db, { tenantId, locationId, connectionType } = {}) {
  const identity = (v) => v;
  const want = normalizeConnectionType(connectionType);
  if (!want || !db?.location?.findUnique || !tenantId || !locationId) return identity;

  const loc = await db.location.findUnique({
    where: { id: locationId }, select: { code: true },
  }).catch(() => null);
  if (!loc?.code) return identity;

  const cfg = await db.marketPricingConfig.findUnique({
    where: { tenantId_locationCode: { tenantId, locationCode: loc.code } },
    select: { connectionType: true, taxes: true, brokeragePct: true },
  }).catch(() => null);
  if (!cfg) return identity;

  const from = normalizeConnectionType(cfg.connectionType) || 'TITANIUM';
  if (from === want) return identity;

  const priced = {
    connectionType: from,
    taxes: Array.isArray(cfg.taxes) ? cfg.taxes : [],
    brokeragePct: Number(cfg.brokeragePct) || 0,
  };

  const { rebaseForConnection } = await import('../../market-scraper/pricing-grossup.js');
  return (value) => {
    const out = rebaseForConnection(value, priced, want);
    // A value we could not re-solve is passed through unchanged rather than
    // dropped: an unconverted price is wrong by a margin, a missing one is a
    // class that silently stops being published.
    return out == null ? value : out;
  };
}

/** Pure: the effective daily for a pair on a date — override wins, base backs it. */
export function effectiveDaily(overrides, pairKey, isoDate, baseDaily) {
  const byDate = overrides?.get?.(pairKey);
  if (byDate && byDate.has(isoDate)) return byDate.get(isoDate);
  const base = Number(baseDaily);
  return Number.isFinite(base) && base > 0 ? Math.round((base + Number.EPSILON) * 100) / 100 : null;
}
