/**
 * RateOffer → observation-shaped adapter (Fase A of the RateOffer consumer
 * cutover, 2026-07-03).
 *
 * The droplet scraper now writes RateOffer rows (Kayak metasearch + any
 * surviving direct sources) instead of MarketObservation. Every consumer of
 * competitor prices (dashboard, exports, comparison, pricing engine) reads
 * through loadCompetitorRows() below, which DUAL-READS both tables and merges
 * them into the legacy observation shape — so downstream aggregation code and
 * the frontend stay untouched, and history charts remain continuous across the
 * Jul-1 source switch.
 *
 * Semantics decided by Hector (2026-07-03):
 *   - vendor = offer.supplier (the rental AGENCY). One supplier quoted via
 *     several OTAs (providers) collapses naturally in the per-vendor min
 *     aggregators: the competitive ladder is a ladder of AGENCIES.
 *   - Offers with supplier === '' (agency unknown) are EXCLUDED from the
 *     competitive rows entirely — an anonymous quote can't sit on the agency
 *     ladder. They're surfaced in totals.anonymousOffers for observability.
 *   - Expedia-channel precedence: when the SAME (pickupDate, sipp, supplier)
 *     appears both as a direct-Expedia row (legacy MarketObservation or
 *     source=EXPEDIA_DIRECT offer) and as a Kayak-relayed Expedia quote
 *     (source=KAYAK, provider='Expedia'), the direct row wins and the Kayak
 *     relay is dropped — same channel, second-hand copy.
 *
 * PRICING GATE (2026-07-03, Hector — CRITICAL, 15 PricingRule mode=AUTO rows
 * are live in prod; hardened from a KAYAK denylist to a per-source ALL-IN
 * ALLOWLIST 2026-09-02, same behavior for today's three sources):
 *   The tax-aware pricing path (beta.202 gross-up) assumes effectiveDailyPrice
 *   is ALL-IN; feeding it a teaser makes baseFromCustomerAllIn() back-solve a
 *   base rate ~18-25% too low, and the live AUTO rules would silently undercut
 *   ourselves every run. purpose:'pricing' reads therefore keep ONLY rows whose
 *   source is confirmed all-in (sourceAllInConfirmed):
 *     - EXPEDIA_DIRECT, CARRENTALS: effective prices are scraped all-in —
 *       confirmed, always allowed.
 *     - KAYAK: effectiveDailyPrice is a TEASER (totalPrice/lorDays where
 *       totalPrice does NOT include taxes/fees). Excluded until the scraper
 *       team confirms it is all-in; flip KAYAK_EFFECTIVE_IS_ALL_IN=true (env)
 *       once confirmed.
 *     - ANY source not in the allowlist (a future Skyscanner, an enum addition
 *       nobody vetted): NOT confirmed → excluded from pricing BY DEFAULT. A
 *       new source must be added to sourceAllInConfirmed deliberately before
 *       it can move a live price.
 *   Display reads ('display') include every source — a chart/table can label
 *   a teaser; an AUTO price write cannot.
 */
import { vendorKey } from './market-vendor.js';

/**
 * True once Hector has confirmed (with the scraper team) that Kayak's
 * effectiveDailyPrice is the ALL-IN price. Read at call time so tests and a
 * droplet restart pick up the env without a rebuild. Default: NOT confirmed.
 */
export function kayakAllInConfirmed() {
  return process.env.KAYAK_EFFECTIVE_IS_ALL_IN === 'true';
}

/**
 * Per-source ALL-IN confirmation ALLOWLIST (2026-09-02). purpose:'pricing'
 * keeps a row only when this returns true for its source. The default for a
 * source that is not listed here is FALSE — a brand-new source (Skyscanner or
 * anything else) is excluded from price COMPUTATION until someone confirms its
 * effectiveDailyPrice is all-in and adds it here, deliberately. Display reads
 * are never gated by this.
 */
export function sourceAllInConfirmed(source) {
  switch (source) {
    // Direct scrapers write all-in effective prices — confirmed (2026-07-03
    // note above), always allowed.
    case 'EXPEDIA_DIRECT':
    case 'CARRENTALS':
      return true;
    // Teaser until the scraper team confirms; env read at call time so tests
    // and a droplet restart pick it up without a rebuild (kayakAllInConfirmed).
    case 'KAYAK':
      return kayakAllInConfirmed();
    // Unknown / future source: NOT confirmed → pricing-excluded by default.
    default:
      return false;
  }
}

/**
 * Map a RateOffer row to the MarketObservation shape every downstream
 * aggregator expects. vendor = supplier (the rental agency); the quoting OTA
 * travels along as `provider` and the scrape channel as `source`.
 */
export function offerToObservationRow(offer) {
  return {
    id: offer.id,
    vendor: offer.supplier,
    sipp: offer.sipp,
    rawCategory: offer.rawCategory,
    dailyPrice: offer.dailyPrice,
    effectiveDailyPrice: offer.effectiveDailyPrice,
    totalPrice: offer.totalPrice,
    lorDays: offer.lorDays,
    pickupDate: offer.pickupDate,
    returnDate: offer.returnDate,
    observedAt: offer.observedAt,
    status: offer.status,
    provider: offer.provider,
    source: offer.source,
    runId: offer.runId,
    profileId: offer.profileId,
  };
}

const dateISO = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Dedup key for the Expedia-channel precedence rule. */
function channelKey(row) {
  return `${dateISO(row.pickupDate)}|${row.sipp}|${vendorKey(row.vendor)}`;
}

/**
 * Build the shared prisma `where` pieces from the adapter's filter object.
 * Both models share the field names we filter on (runId, profileId, sipp,
 * observedAt, pickupDate, status, profile relation).
 */
function baseWhere(filters) {
  const where = { status: 'FOUND' };
  if (filters.runId) where.runId = filters.runId;
  if (filters.profileId) where.profileId = filters.profileId;
  if (Array.isArray(filters.profileIds)) where.profileId = { in: filters.profileIds };
  if (filters.sipp) where.sipp = filters.sipp;
  if (filters.observedSince) where.observedAt = { gte: filters.observedSince };
  if (filters.pickupFrom || filters.pickupTo) {
    where.pickupDate = {
      ...(filters.pickupFrom ? { gte: filters.pickupFrom } : {}),
      ...(filters.pickupTo ? { lte: filters.pickupTo } : {}),
    };
  }
  if (filters.profile) where.profile = filters.profile;
  return where;
}

/**
 * Dual-read competitor prices: RateOffer (new) + MarketObservation (legacy),
 * merged into one observation-shaped array.
 *
 * @param {object} prismaClient  prisma (injected for testability)
 * @param {object} filters       { runId?, profileId?, profileIds?, sipp?,
 *                                 observedSince?, pickupFrom?, pickupTo?,
 *                                 profile? (relation where, e.g. {locationCode, tenantId}) }
 * @param {object} opts          { purpose: 'display' | 'pricing' }
 *   - 'pricing': feeds price COMPUTATION (suggestions, AUTO rules, run
 *     comparison). Only sources on the all-in allowlist survive
 *     (sourceAllInConfirmed): EXPEDIA_DIRECT + CARRENTALS always, KAYAK only
 *     when KAYAK_EFFECTIVE_IS_ALL_IN=true, anything else never — see the gate
 *     note at the top.
 *   - 'display': feeds charts/tables/exports. Every source included (labelable).
 *
 * @returns {Promise<{rows: Array<object>, totals: {anonymousOffers: number}}>}
 *   rows sorted by (pickupDate, sipp, dailyPrice) for stable output.
 */
export async function loadCompetitorRows(prismaClient, filters = {}, opts = {}) {
  // FAIL-CLOSED default (Innovation review 2026-07-02): a caller that forgets
  // opts.purpose gets 'pricing' — i.e. Kayak teaser rows EXCLUDED. Defaulting
  // to 'display' would let a future pricing path silently consume teaser-basis
  // prices and undercut via the live AUTO rules (invisible failure); a display
  // caller that forgets merely loses Kayak rows from a chart (visible, benign).
  const purpose = opts.purpose === 'display' ? 'display' : 'pricing';
  const where = baseWhere(filters);

  const [offers, observations] = await Promise.all([
    prismaClient.rateOffer.findMany({
      where: {
        ...where,
        // Usable price: Kayak rows may carry only effectiveDailyPrice.
        OR: [{ dailyPrice: { not: null } }, { effectiveDailyPrice: { not: null } }],
      },
    }),
    prismaClient.marketObservation.findMany({
      where: { ...where, dailyPrice: { not: null } },
    }),
  ]);

  // Anonymous-supplier exclusion (Hector 2026-07-03): supplier === '' can't
  // sit on the agency ladder. Counted so ops can see how much we're dropping.
  let anonymousOffers = 0;
  const offerRows = [];
  for (const offer of offers) {
    if (offer.supplier === '' || offer.supplier == null) { anonymousOffers += 1; continue; }
    offerRows.push(offerToObservationRow(offer));
  }

  // Legacy observations were written by the direct-Expedia scraper: they carry
  // provider 'Expedia' / source 'EXPEDIA_DIRECT' implicitly.
  const obsRows = observations.map((o) => ({
    ...o,
    provider: 'Expedia',
    source: 'EXPEDIA_DIRECT',
  }));

  let rows = [...obsRows, ...offerRows];

  // PROVIDER FILTER (2026-07-29, Hector) — narrow the view to specific OTAs
  // (Expedia, Priceline, EconomyBookings, Booking.com...). Applied in memory
  // because provider values are free-form mixed case ('Booking.com',
  // 'EconomyBookings') and the legacy observations get their provider assigned
  // above rather than in SQL, so one case-insensitive pass covers both models.
  //
  // DELIBERATELY independent of `purpose`: only a caller that PASSES providers
  // is filtered. Every pricing caller omits it, so the suggestion math still
  // sees the full multi-OTA pool and keeps collapsing it into the per-AGENCY
  // ladder — this narrows what you LOOK at, never what we price against.
  const providerFilter = Array.isArray(filters.providers)
    ? filters.providers.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : null;
  if (providerFilter && providerFilter.length) {
    const wanted = new Set(providerFilter);
    rows = rows.filter((r) => wanted.has(String(r.provider || '').trim().toLowerCase()));
  }

  // Expedia-channel precedence: a Kayak-relayed Expedia quote is a second-hand
  // copy of the direct row — drop it when the direct row is in this result set.
  const directKeys = new Set();
  for (const r of rows) {
    if (r.source === 'EXPEDIA_DIRECT') directKeys.add(channelKey(r));
  }
  if (directKeys.size > 0) {
    rows = rows.filter((r) => !(
      r.source === 'KAYAK'
      && String(r.provider || '').toUpperCase() === 'EXPEDIA'
      && directKeys.has(channelKey(r))
    ));
  }

  // PRICING GATE — see module header. ALL-IN ALLOWLIST: a row feeds price
  // computation only when its source is confirmed all-in. A source missing
  // from the allowlist (any future addition) is dropped here by default —
  // display reads are never gated.
  if (purpose === 'pricing') {
    rows = rows.filter((r) => sourceAllInConfirmed(r.source));
  }

  rows.sort((a, b) => {
    const da = dateISO(a.pickupDate); const db = dateISO(b.pickupDate);
    if (da !== db) return da < db ? -1 : 1;
    if (a.sipp !== b.sipp) return a.sipp < b.sipp ? -1 : 1;
    return (Number(a.dailyPrice ?? a.effectiveDailyPrice) || 0) - (Number(b.dailyPrice ?? b.effectiveDailyPrice) || 0);
  });

  return { rows, totals: { anonymousOffers } };
}

export const rateOfferSource = { offerToObservationRow, loadCompetitorRows, kayakAllInConfirmed, sourceAllInConfirmed };
