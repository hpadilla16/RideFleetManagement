import { prisma } from '../../lib/prisma.js';
import { applyStrategy, ruleLabelFor, getCompetitorExcludeSet, getMarketPricingConfig } from '../market-scraper/market-scrape-comparison.service.js';
import { isExcludedVendor, normalizeVendorName, vendorKey } from '../market-scraper/market-vendor.js';
import { loadCompetitorRows, kayakAllInConfirmed } from '../market-scraper/rate-offer-source.js';
import { baseFromCustomerAllIn, customerAllInFromBase } from '../market-scraper/pricing-grossup.js';
import { buildUtilizationLookup } from '../market-scraper/pricing-utilization.js';
import { pickUtilizationTier, resolveTierTarget } from '../market-scraper/pricing-tiers.js';
import { renderReportExcel } from '../reports/reports-export.js';

/**
 * Query services backing the Market Intelligence Dashboard, SIPP detail view,
 * and the Pricing Intelligence panel on the Rate edit page.
 *
 * Conventions:
 *   - All reads are tenant-scoped via the profile that produced the observation
 *     (MarketScrapeProfile.tenantId). Super-admins with no tenantId in scope
 *     see global; non-admins without tenant get the deny-all sentinel.
 *   - "Latest" snapshot = most recent observedAt per (profileId, sipp, pickupDate),
 *     bounded to the last 24h so a stale FAILED run can't pollute results.
 *   - All prices returned as numbers, not Decimal. Frontend formats display.
 */

const NUM = (v) => (v == null ? null : Number(v));

function tenantFilter(scope) {
  // We filter via the parent MarketScrapeProfile.tenantId. The observation
  // itself doesn't carry tenantId so we always go through the profile relation.
  if (scope.tenantId === '__no_tenant__') return { profile: { tenantId: '__no_tenant__' } };
  if (scope.tenantId) return { profile: { tenantId: scope.tenantId } };
  return {}; // super-admin global
}

/**
 * GET /api/market/airports
 *
 * The airports this tenant actually scrapes — the source of truth for every
 * airport picker in the UI.
 *
 * WHY THIS IS DRIVEN BY PROFILES AND NOT BY `Location` (2026-07-24): the code
 * this whole module keys on is `MarketScrapeProfile.locationCode`, which is
 * ALSO what the scraper puts in the Kayak URL (`kayak.com/cars/<code>/...`), so
 * it has to be a real IATA code. A tenant's `Location.code` is a free-form
 * label and frequently isn't one — Corpusa's LAX branch is coded `LAXA01` (a
 * Rightcars station code), so a picker built from `Location` asked for
 * `LAXA01`, matched no profile, and silently rendered an empty dashboard. It
 * only ever worked for the first tenant because they happened to name their
 * location `SJU`.
 *
 * Listing profiles also means the picker can only offer airports that have data
 * behind them — you can't select your way into an empty screen.
 *
 * `label` borrows the Location's name when the codes DO line up, and falls back
 * to the bare code otherwise. Cosmetic only; `code` is the key.
 */
export async function listMarketAirports({ scope }) {
  const where = { active: true };
  if (scope?.tenantId === '__no_tenant__') where.tenantId = '__no_tenant__';
  else if (scope?.tenantId) where.tenantId = scope.tenantId;

  const profiles = await prisma.marketScrapeProfile.findMany({
    where,
    select: { locationCode: true },
    distinct: ['locationCode'],
  });
  const codes = [...new Set(
    profiles.map((p) => String(p.locationCode || '').trim().toUpperCase()).filter(Boolean)
  )].sort();
  if (!codes.length) return { airports: [] };

  // Cosmetic join: only hits when the tenant's Location.code IS the airport
  // code. A miss is expected and harmless — see the LAXA01 note above.
  const locations = scope?.tenantId && scope.tenantId !== '__no_tenant__'
    ? await prisma.location.findMany({
        where: { tenantId: scope.tenantId, code: { in: codes } },
        select: { code: true, name: true, city: true },
      })
    : [];
  const byCode = new Map(locations.map((l) => [String(l.code).toUpperCase(), l]));

  const airports = codes.map((code) => {
    const loc = byCode.get(code);
    const place = loc?.city || loc?.name || null;
    return { code, label: place ? `${code} — ${place}` : code };
  });
  return { airports };
}

/**
 * GET /api/market/summary?airport=SJU
 *
 * For every SIPP class observed at the airport in the last 24h, return:
 *   - currentMedian, currentMin, currentMax
 *   - top 5 vendors with their current dailyPrice (cheapest-first)
 *   - your rate row (if a Rate exists matching the airport + SIPP via
 *     MarketScrapeProfile.targetRateId), and your rank in the sorted list
 *   - weekly delta vs the median 7 days ago
 *
 * Used by the Market Intelligence Dashboard (1 card per SIPP class) and the
 * Pricing Intelligence panel ("current market position" card).
 */
export async function getMarketSummary({ airport, scope }) {
  if (!airport) {
    const err = new Error('airport query param is required');
    err.httpStatus = 400;
    throw err;
  }

  // Dashboard SIPP picker (beta.134): the tenant may pin up to 6 SIPP codes to
  // their MI dashboard card. Returned as `preferredSipps` so the card can show
  // those (in the tenant's order) instead of the default top-6-by-volume. Empty
  // array → frontend keeps the top-6 fallback.
  let preferredSipps = [];
  if (scope.tenantId && scope.tenantId !== '__no_tenant__') {
    const tenant = await prisma.tenant.findUnique({
      where: { id: scope.tenantId },
      select: { dashboardSipps: true },
    });
    preferredSipps = Array.isArray(tenant?.dashboardSipps)
      ? tenant.dashboardSipps.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean)
      : [];
  }

  const profileWhere = {
    locationCode: airport.toUpperCase(),
    active: true,
    ...(scope.tenantId === '__no_tenant__'
      ? { tenantId: '__no_tenant__' }
      : scope.tenantId
        ? { tenantId: scope.tenantId }
        : {}),
  };

  // Find the profiles we'll aggregate over (one tenant typically has the
  // 1-14/15-28/29-60 trio per airport — we union all of them).
  const profiles = await prisma.marketScrapeProfile.findMany({
    where: profileWhere,
    select: { id: true, tenantId: true, targetRateId: true },
  });
  if (profiles.length === 0) {
    return { airport: airport.toUpperCase(), sipps: [], updatedAt: null, preferredSipps };
  }

  const profileIds = profiles.map((p) => p.id);

  // Last-24h competitor rows for these profiles, only FOUND rows (drop
  // UNMAPPED). Dual-read (RateOffer + legacy MarketObservation) through the
  // adapter — purpose:'display' includes Kayak-sourced quotes (2026-07-03
  // cutover; dashboards can show teasers, the pricing path cannot).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { rows: obs } = await loadCompetitorRows(
    prisma,
    { profileIds, observedSince: since },
    { purpose: 'display' }
  );

  // Build a SIPP → tenant's own Rate mapping.
  //
  // Multi-SIPP world: a tenant has one Rate per SIPP class, each with a
  // PricingRule that carries `rule.sipp` (added in beta.127). The summary
  // endpoint correlates "your price" for each SIPP through that link, NOT
  // through the legacy `MarketScrapeProfile.targetRateId` which is null
  // for tenants who scrape all SIPPs in a single profile.
  //
  // Filter Rates by (a) the active PricingRule's sipp + (b) the Rate's
  // location matching the airport code. That way a tenant with rates in
  // SJU + MCO returns the SJU rate when the dashboard asks for SJU.
  // Tax-aware config for this airport (opt-in): when present, your own rate is shown
  // as ALL-IN (base × grossup) so it's comparable to the competitor all-in prices the
  // charts plot — otherwise the card would compare your BASE against their all-in.
  const pricingConfig = await getMarketPricingConfig(scope.tenantId, airport.toUpperCase());

  const ownRatesBySipp = new Map();
  if (scope.tenantId && scope.tenantId !== '__no_tenant__') {
    const rules = await prisma.pricingRule.findMany({
      where: {
        tenantId: scope.tenantId,
        sipp: { not: null },
        active: true,
        rate: {
          location: { code: airport.toUpperCase() },
        },
      },
      select: {
        sipp: true,
        rate: { select: { id: true, rateCode: true, daily: true, name: true } },
      },
    });
    for (const r of rules) {
      if (r.sipp && r.rate && !ownRatesBySipp.has(r.sipp)) {
        ownRatesBySipp.set(r.sipp, r.rate);
      }
    }
  }

  // Build a map: sipp -> sorted vendor-min prices.
  //
  // PRICE FIELD: we use `effectiveDailyPrice` (= totalPrice / lorDays) as the
  // primary number throughout. That's the apples-to-apples "real" daily cost
  // including taxes + fees — which is what Rate Highway tracks and what
  // pricing decisions should be made against. `dailyPrice` is the Expedia
  // teaser ($11/day) which can be 50%+ below the real all-in cost.
  // Fallback to dailyPrice if effectiveDailyPrice is null (legacy rows).
  const priceOf = (o) =>
    o.effectiveDailyPrice != null ? Number(o.effectiveDailyPrice) : Number(o.dailyPrice);

  // Competitor-pool hygiene: drop the tenant's own brand / configured exclusions
  // and normalize vendor spellings so one brand isn't double-counted.
  const excludeSet = await getCompetitorExcludeSet(scope.tenantId);
  const bySipp = new Map();
  for (const o of obs) {
    if (isExcludedVendor(o.vendor, excludeSet)) continue;
    if (!bySipp.has(o.sipp)) bySipp.set(o.sipp, []);
    bySipp.get(o.sipp).push({
      vendor: normalizeVendorName(o.vendor),
      price: priceOf(o),
      teaserPrice: NUM(o.dailyPrice),
      observedAt: o.observedAt,
    });
  }

  const sipps = [];
  for (const [sipp, rows] of bySipp.entries()) {
    if (rows.length === 0) continue;
    // Per-vendor min price for the bracket (one vendor can show many pickup
    // dates; the user wants "this vendor's cheapest right now").
    const perVendor = new Map();
    for (const r of rows) {
      const key = (r.vendor || '?').trim();
      const prev = perVendor.get(key);
      if (prev == null || r.price < prev) perVendor.set(key, r.price);
    }
    const ordered = Array.from(perVendor.entries())
      .map(([vendor, price]) => ({ vendor, price }))
      .sort((a, b) => a.price - b.price);

    const prices = ordered.map((v) => v.price);
    const median = prices[Math.floor(prices.length / 2)];
    const min = prices[0];
    const max = prices[prices.length - 1];

    // Look up the tenant's Rate for THIS specific SIPP via the
    // PricingRule.sipp map built above. If none exists yet (tenant hasn't
    // configured a rule for this class), `yourRate` is null and the
    // dashboard shows "—" for that card.
    const ownRate = ownRatesBySipp.get(sipp);
    let yourRow = null;
    if (ownRate) {
      const base = Number(ownRate.daily);
      // With a tax-aware config, `daily` becomes your ALL-IN (base × grossup) so the card
      // ranks you against the competitor all-in. `base` keeps the uploaded number.
      const allIn = pricingConfig ? customerAllInFromBase(base, pricingConfig) : null;
      yourRow = {
        id: ownRate.id,
        code: ownRate.rateCode,
        daily: allIn != null ? allIn : base, // comparable number shown on the card
        base,
        allIn: allIn != null,
      };
    }

    let yourRank = null;
    if (yourRow) {
      const idx = ordered.findIndex((v) => v.price >= yourRow.daily);
      yourRank = idx === -1 ? ordered.length + 1 : idx + 1;
    }

    sipps.push({
      sipp,
      median,
      min,
      max,
      vendorCount: ordered.length,
      topVendors: ordered.slice(0, 5),
      yourRate: yourRow,
      yourRank,
    });
  }

  // Sort by largest absolute median for now; frontend can resort.
  sipps.sort((a, b) => (b.median ?? 0) - (a.median ?? 0));
  const updatedAt =
    obs.length === 0 ? null : new Date(Math.max(...obs.map((o) => o.observedAt.getTime())));

  return { airport: airport.toUpperCase(), sipps, updatedAt, preferredSipps };
}

/**
 * GET /api/market/history?airport=SJU&sipp=IFAR&days=14
 *
 * Time-series per (airport, sipp). For each day in the window we emit:
 *   { date, median, p25, p75, min, max, vendorCount }
 * plus per-vendor series for the top N vendors so the SIPP Detail page can
 * render lines for "your top 3 competitors".
 *
 * Used by the SIPP Detail drill-down chart (stock-market style) and the
 * sparkline mini-charts on the dashboard.
 */
export async function getMarketHistory({ airport, sipp, days = 14, mode = 'history', scope }) {
  if (!airport || !sipp) {
    const err = new Error('airport and sipp query params are required');
    err.httpStatus = 400;
    throw err;
  }
  const lookbackDays = Math.max(1, Math.min(120, Number(days) || 14));
  const isForward = String(mode) === 'forward';

  const profileWhere = {
    locationCode: airport.toUpperCase(),
    active: true,
    ...(scope.tenantId === '__no_tenant__'
      ? { tenantId: '__no_tenant__' }
      : scope.tenantId
        ? { tenantId: scope.tenantId }
        : {}),
  };
  const profiles = await prisma.marketScrapeProfile.findMany({
    where: profileWhere,
    select: { id: true },
  });
  if (profiles.length === 0) return { airport: airport.toUpperCase(), sipp, days: lookbackDays, series: [], vendors: {} };

  const profileIds = profiles.map((p) => p.id);

  // See note in getMarketSummary — effectiveDailyPrice is the primary number
  // (total / lor = real all-in daily cost), falling back to dailyPrice.
  const priceOf = (o) =>
    o.effectiveDailyPrice != null ? Number(o.effectiveDailyPrice) : Number(o.dailyPrice);

  // Competitor-pool hygiene (own brand out, vendor names normalized).
  const excludeSet = await getCompetitorExcludeSet(scope.tenantId);

  // byDate: array of {vendor, price} per chart day.
  //   - history mode : day = observedAt — how the market moved while we watched.
  //   - forward mode : day = FUTURE pickupDate, using the LATEST quote per
  //     (pickupDate, vendor) — the forward booking curve for the next N days
  //     (this is the forecasting view; works even if we've only scraped a few days).
  const byDate = new Map();
  if (isForward) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + lookbackDays * 24 * 60 * 60 * 1000);
    // Dual-read via the adapter (RateOffer + legacy observations) — display purpose.
    const { rows: obs } = await loadCompetitorRows(
      prisma,
      { profileIds, sipp, pickupFrom: start, pickupTo: end },
      { purpose: 'display' }
    );
    // Keep only the most recent observation per (pickupDate, vendor).
    const latest = new Map();
    for (const o of obs) {
      if (isExcludedVendor(o.vendor, excludeSet)) continue;
      const day = o.pickupDate.toISOString().slice(0, 10);
      const key = `${day}|${normalizeVendorName(o.vendor) || '?'}`;
      const prev = latest.get(key);
      if (!prev || o.observedAt > prev.o.observedAt) latest.set(key, { day, o });
    }
    for (const { day, o } of latest.values()) {
      if (!byDate.has(day)) byDate.set(day, []);
      byDate.get(day).push({ vendor: normalizeVendorName(o.vendor) || '?', price: priceOf(o) });
    }
  } else {
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
    // Dual-read keeps the history chart CONTINUOUS across the Jul-1 source
    // switch: pre-Jul-1 days come from MarketObservation, later days from
    // RateOffer — one series, no gap.
    const { rows: obs } = await loadCompetitorRows(
      prisma,
      { profileIds, sipp, observedSince: since },
      { purpose: 'display' }
    );
    for (const o of obs) {
      if (isExcludedVendor(o.vendor, excludeSet)) continue;
      const day = o.observedAt.toISOString().slice(0, 10);
      if (!byDate.has(day)) byDate.set(day, []);
      byDate.get(day).push({ vendor: normalizeVendorName(o.vendor) || '?', price: priceOf(o) });
    }
  }

  // Compute median + percentiles per day.
  const series = [];
  for (const [day, rows] of byDate.entries()) {
    const sorted = [...rows].sort((a, b) => a.price - b.price);
    const prices = sorted.map((r) => r.price);
    series.push({
      date: day,
      min: prices[0],
      p25: percentile(prices, 0.25),
      median: percentile(prices, 0.5),
      p75: percentile(prices, 0.75),
      max: prices[prices.length - 1],
      vendorCount: new Set(sorted.map((r) => r.vendor)).size,
    });
  }
  series.sort((a, b) => a.date.localeCompare(b.date));

  // Pick top vendors by total appearance count across the window for the
  // per-vendor lines. Then emit per-vendor min price per day.
  const vendorCounts = new Map();
  for (const rows of byDate.values()) {
    for (const r of rows) {
      const v = (r.vendor || '?').trim();
      vendorCounts.set(v, (vendorCounts.get(v) || 0) + 1);
    }
  }
  const topVendors = Array.from(vendorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map((x) => x[0]);

  const vendorSeries = {};
  for (const v of topVendors) vendorSeries[v] = [];
  for (const day of series.map((s) => s.date)) {
    const rowsForDay = byDate.get(day) || [];
    for (const v of topVendors) {
      const vRows = rowsForDay.filter((r) => r.vendor === v);
      const price = vRows.length === 0 ? null : Math.min(...vRows.map((r) => r.price));
      vendorSeries[v].push({ date: day, price });
    }
  }

  return {
    airport: airport.toUpperCase(),
    sipp,
    days: lookbackDays,
    mode: isForward ? 'forward' : 'history',
    series,
    vendors: vendorSeries,
  };
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.floor((sortedAsc.length - 1) * p);
  return sortedAsc[idx];
}

/**
 * Dashboard-level Excel export (discoverable from /market), RateHighway-style.
 *
 * Unlike a single-run snapshot, this covers the FORWARD BOOKING WINDOW the dashboard's
 * 7d / 14d / 30d selector is showing: for every pickup day in [today, today+days] and
 * every SIPP class, it takes the LATEST quote per competitor, picks the cheapest, applies
 * the owning profile's pricing strategy to get a suggested price, and compares it to the
 * tenant's current rate for that class. One row per (pickup day × class), exactly like the
 * RateHighway export. Returns { buffer, filename }.
 */
export async function buildAirportExportWorkbook({ airport, days, scope = {} }) {
  if (!airport) {
    const err = new Error('airport query param is required'); err.httpStatus = 400; throw err;
  }
  const A = String(airport).toUpperCase();
  const windowDays = Math.max(1, Math.min(60, Number(days) || 14));

  const profileWhere = {
    locationCode: A,
    active: true,
    ...(scope.tenantId === '__no_tenant__'
      ? { tenantId: '__no_tenant__' }
      : scope.tenantId ? { tenantId: scope.tenantId } : {}),
  };
  const profiles = await prisma.marketScrapeProfile.findMany({
    where: profileWhere,
    select: {
      id: true, tenantId: true,
      strategy: true, strategyAmount: true, strategyPct: true, strategyFloor: true,
    },
  });
  if (profiles.length === 0) {
    const err = new Error('No market profile for this airport yet'); err.httpStatus = 404; throw err;
  }
  const profById = new Map(profiles.map((p) => [p.id, p]));
  const profileIds = profiles.map((p) => p.id);

  // Forward window: FUTURE pickup dates in [today, today+windowDays].
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + windowDays * 24 * 60 * 60 * 1000);
  // Dual-read via the adapter (RateOffer + legacy observations) — display
  // purpose: the export mirrors what the dashboard shows, Kayak included.
  const { rows: obs } = await loadCompetitorRows(
    prisma,
    { profileIds, pickupFrom: start, pickupTo: end },
    { purpose: 'display' }
  );

  // Same price basis as the dashboard cards: effectiveDailyPrice (total / LOR = real all-in
  // daily cost) with a fallback to the teaser dailyPrice for legacy rows.
  const priceOf = (o) => (o.effectiveDailyPrice != null ? Number(o.effectiveDailyPrice) : Number(o.dailyPrice));

  // Competitor-pool hygiene (own brand out, vendor names normalized).
  const excludeSet = await getCompetitorExcludeSet(scope.tenantId);

  // Staleness dedup (2026-07-03 RateOffer cutover): keep only the LATEST quote
  // per (pickupDate, sipp, supplier, PROVIDER) — the same agency quoted by two
  // OTAs is two distinct quotes, each with its own freshness — then collapse to
  // the MIN across providers per supplier so the ladder stays a ladder of
  // AGENCIES (one row per supplier per cell, like before the cutover).
  const latest = new Map(); // date|sipp|supplierKey|provider -> latest row
  for (const o of obs) {
    if (isExcludedVendor(o.vendor, excludeSet)) continue;
    const dISO = o.pickupDate.toISOString().slice(0, 10);
    const key = `${dISO}|${o.sipp}|${vendorKey(o.vendor) || '?'}|${o.provider || '?'}`;
    const prev = latest.get(key);
    if (!prev || o.observedAt > prev.observedAt) latest.set(key, o);
  }
  const perSupplier = new Map(); // date|sipp|supplierKey -> cheapest row across providers
  for (const o of latest.values()) {
    const dISO = o.pickupDate.toISOString().slice(0, 10);
    const key = `${dISO}|${o.sipp}|${vendorKey(o.vendor) || '?'}`;
    const prev = perSupplier.get(key);
    if (!prev || priceOf(o) < priceOf(prev)) perSupplier.set(key, o);
  }
  // Cheapest competitor per (pickupDate, sipp) + the per-vendor price ladder (for tiers).
  // TWO cell maps (QA finding 2026-07-02): the export's OBSERVED-market columns
  // (Market cheapest / vendor / sampled) mirror the dashboard — Kayak included.
  // But the SUGGESTED / "Uploaded Rate (base)" columns run the same pricing
  // math as the AUTO rules, and someone uploads that sheet by hand — so those
  // columns must compute from the PRICING-eligible pool only (Kayak teaser rows
  // excluded until KAYAK_EFFECTIVE_IS_ALL_IN is confirmed; same gate as the
  // engine). Otherwise the manual upload loop undercuts exactly like the AUTO
  // path the gate protects.
  const kayakOk = kayakAllInConfirmed();
  const pricingEligible = (o) => o.source !== 'KAYAK' || kayakOk;
  const byCell = new Map(); // display cells: `${dISO}|${sipp}` -> { date, sipp, cheapest, vendor, sampled, profileId, prices[] }
  const byCellPricing = new Map(); // pricing cells: same shape, gate-filtered rows only
  const addToCellMap = (map, o) => {
    const price = priceOf(o);
    if (!Number.isFinite(price) || price <= 0) return;
    const dISO = o.pickupDate.toISOString().slice(0, 10);
    const vendor = normalizeVendorName(o.vendor) || null;
    const key = `${dISO}|${o.sipp}`;
    const ex = map.get(key);
    if (!ex) {
      map.set(key, { date: dISO, sipp: o.sipp, cheapest: price, vendor, sampled: 1, profileId: o.profileId, prices: [price] });
    } else {
      ex.sampled += 1;
      ex.prices.push(price);
      if (price < ex.cheapest) { ex.cheapest = price; ex.vendor = vendor; ex.profileId = o.profileId; }
    }
  };
  for (const o of perSupplier.values()) {
    addToCellMap(byCell, o);
    if (pricingEligible(o)) addToCellMap(byCellPricing, o);
  }

  // Tenant's current rate per SIPP (same mapping as getMarketSummary: active PricingRule
  // carrying the sipp, whose Rate is at this airport). One "your price" number per class.
  const ownDailyBySipp = new Map();
  if (scope.tenantId && scope.tenantId !== '__no_tenant__') {
    const rules = await prisma.pricingRule.findMany({
      where: { tenantId: scope.tenantId, sipp: { not: null }, active: true, rate: { location: { code: A } } },
      select: { sipp: true, rate: { select: { daily: true } } },
    });
    for (const r of rules) {
      if (r.sipp && r.rate && !ownDailyBySipp.has(r.sipp)) ownDailyBySipp.set(r.sipp, Number(r.rate.daily));
    }
  }

  // Tax-aware config for this airport (opt-in). When present, the cheapest is ALL-IN
  // (we already use effectiveDailyPrice) and we back-solve the BASE to upload.
  const pricingConfig = await getMarketPricingConfig(scope.tenantId, A);
  const taxAware = !!pricingConfig;
  const floorBase = pricingConfig?.floorBase != null ? Number(pricingConfig.floorBase) : null;

  // Flatten to rows: one per (pickup day × class), sorted by day then class.
  const cells = [...byCell.values()].sort((a, b) => (a.date === b.date ? a.sipp.localeCompare(b.sipp) : a.date.localeCompare(b.date)));

  // Utilization tiers (Fase 2): only when tax-aware AND this location has rules.
  const utilRules = Array.isArray(pricingConfig?.utilizationRules) ? pricingConfig.utilizationRules : [];
  let utilLookup = { utilOf: () => null };
  if (taxAware && utilRules.length > 0 && cells.length) {
    const ds = [...new Set(cells.map((c) => c.date))].sort();
    utilLookup = await buildUtilizationLookup({ tenantId: scope.tenantId, locationCode: A, fromISO: ds[0], toISO: ds[ds.length - 1] });
  }

  const rhRows = cells.map((c) => {
    const profile = profById.get(c.profileId) || null;
    // Pricing math runs on the GATE-FILTERED cell (see byCellPricing above).
    // No pricing-eligible competitor for this cell → suggested/uploaded stay
    // null (the observed-market columns still show the Kayak view).
    const p = byCellPricing.get(`${c.date}|${c.sipp}`) || null;
    // When utilization has reached a tier, position on the competitive ladder; else base margin.
    let utilization = null;
    let tier = null;
    if (taxAware && utilRules.length > 0) {
      utilization = utilLookup.utilOf(c.sipp, c.date);
      tier = pickUtilizationTier(utilization, utilRules);
    }
    let target = null;
    if (p) {
      if (tier) {
        target = resolveTierTarget(tier, p.prices);
        if (target == null) target = applyStrategy(p.cheapest, profile);
      } else {
        target = applyStrategy(p.cheapest, profile);
      }
    }
    let suggestedAllIn = null;
    let uploaded = target; // legacy: upload the target as-is
    // Titanium/Amadeus DUAL bases (LAX meeting, 2026-07-26): the same target
    // all-in back-solved under BOTH gross-up formulas, side by side, so the
    // numbers can be relayed to franchises on either connection (TL runs
    // Titanium; the others run Amadeus). DISPLAY-ONLY — auto-apply and the
    // "Uploaded Rate" column still use the location's configured
    // connectionType, which is the only value that actually gets written.
    let baseTitanium = null;
    let baseAmadeus = null;
    if (taxAware && target != null) {
      suggestedAllIn = target;
      let base = baseFromCustomerAllIn(target, pricingConfig);
      if (base != null && floorBase != null && base < floorBase) base = floorBase;
      uploaded = base;
      baseTitanium = baseFromCustomerAllIn(target, { ...pricingConfig, connectionType: 'TITANIUM' });
      if (baseTitanium != null && floorBase != null && baseTitanium < floorBase) baseTitanium = floorBase;
      baseAmadeus = baseFromCustomerAllIn(target, { ...pricingConfig, connectionType: 'AMADEUS' });
      if (baseAmadeus != null && floorBase != null && baseAmadeus < floorBase) baseAmadeus = floorBase;
    }
    const current = ownDailyBySipp.has(c.sipp) ? ownDailyBySipp.get(c.sipp) : null;
    const diff = (uploaded != null && current != null) ? Number((uploaded - current).toFixed(2)) : null;
    return {
      date: c.date, location: A, sipp: c.sipp, rateCode: 'Daily', rule: ruleLabelFor(profile, '-'),
      marketVendor: c.vendor || '', marketCheapest: Number(c.cheapest.toFixed(2)),
      suggested: (taxAware ? suggestedAllIn : uploaded), uploadedBase: uploaded,
      baseTitanium, baseAmadeus, utilization,
      currentPrice: current, deltaAbs: diff, marketSampled: c.sampled,
    };
  });

  const rhCols = [
    { header: 'Pick-up', key: 'date', width: 12 },
    { header: 'Location', key: 'location', width: 10 },
    { header: 'Car Type', key: 'sipp', width: 10 },
    { header: 'Rate Code', key: 'rateCode', width: 10 },
    { header: 'Rule', key: 'rule', width: 14 },
    { header: 'Comp. Vendor', key: 'marketVendor', width: 18 },
    { header: taxAware ? 'Comp. Rate (all-in)' : 'Comp. Rate', key: 'marketCheapest', type: 'currency', width: 14 },
    { header: taxAware ? 'Suggested (all-in)' : 'Suggested', key: 'suggested', type: 'currency', width: 14 },
    ...(taxAware ? [{ header: 'Uploaded Rate (base)', key: 'uploadedBase', type: 'currency', width: 16 }] : []),
    ...(taxAware ? [{ header: 'Base (Titanium)', key: 'baseTitanium', type: 'currency', width: 14 }] : []),
    ...(taxAware ? [{ header: 'Base (Amadeus)', key: 'baseAmadeus', type: 'currency', width: 14 }] : []),
    ...(taxAware ? [{ header: 'Util %', key: 'utilization', type: 'percent', width: 9 }] : []),
    { header: 'Current Rate', key: 'currentPrice', type: 'currency', width: 12 },
    { header: 'Difference', key: 'deltaAbs', type: 'currency', width: 11 },
    { header: 'Samples', key: 'marketSampled', type: 'integer', width: 9 },
  ];

  // Supporting pivot: cheapest competitor by class (rows) × pickup day (cols).
  const dates = [...new Set(cells.map((c) => c.date))].sort();
  const sipps = [...new Set(cells.map((c) => c.sipp))].sort();
  const cheapestByCell = new Map(cells.map((c) => [`${c.sipp}|${c.date}`, c.cheapest]));
  const fmtDay = (d) => { const p = String(d).split('-'); return p.length === 3 ? `${p[1]}/${p[2]}` : String(d); };
  const pivotCols = [
    { header: 'Vehicle class (SIPP)', key: 'sipp', width: 18 },
    ...dates.map((d) => ({ header: fmtDay(d), key: d, type: 'currency', width: 10 })),
  ];
  const pivotRows = sipps.map((sipp) => {
    const out = { sipp };
    for (const d of dates) { const v = cheapestByCell.get(`${sipp}|${d}`); out[d] = v != null ? Number(v.toFixed(2)) : null; }
    return out;
  });

  const range = dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : 'no upcoming pickups';
  return renderReportExcel({
    title: `Market pricing - ${A}`,
    subtitle: `${A} | next ${windowDays} days (${range}) | generated ${new Date().toISOString().slice(0, 10)}`,
    sheets: [
      { name: 'Pricing recommendations', columns: rhCols, rows: rhRows },
      { name: 'Cheapest by class & day', columns: pivotCols, rows: pivotRows },
    ],
  });
}

export const marketObservationsService = {
  listMarketAirports,
  getMarketSummary,
  getMarketHistory,
  buildAirportExportWorkbook,
};
