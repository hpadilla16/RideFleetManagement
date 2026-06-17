import { prisma } from '../../lib/prisma.js';
import { buildRunComparisonWorkbook } from '../market-scraper/market-scrape-comparison.service.js';

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

  // Last-24h observations for these profiles, only FOUND rows (drop UNMAPPED).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const obs = await prisma.marketObservation.findMany({
    where: {
      profileId: { in: profileIds },
      observedAt: { gte: since },
      status: 'FOUND',
      dailyPrice: { not: null },
    },
    select: {
      sipp: true,
      vendor: true,
      dailyPrice: true,
      effectiveDailyPrice: true,
      pickupDate: true,
      observedAt: true,
    },
  });

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

  const bySipp = new Map();
  for (const o of obs) {
    if (!bySipp.has(o.sipp)) bySipp.set(o.sipp, []);
    bySipp.get(o.sipp).push({
      vendor: o.vendor,
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
    const yourRow = ownRate
      ? { id: ownRate.id, code: ownRate.rateCode, daily: Number(ownRate.daily) }
      : null;

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
export async function getMarketHistory({ airport, sipp, days = 14, scope }) {
  if (!airport || !sipp) {
    const err = new Error('airport and sipp query params are required');
    err.httpStatus = 400;
    throw err;
  }
  const lookbackDays = Math.max(1, Math.min(120, Number(days) || 14));
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

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

  const obs = await prisma.marketObservation.findMany({
    where: {
      profileId: { in: profileIds },
      sipp,
      observedAt: { gte: since },
      status: 'FOUND',
      dailyPrice: { not: null },
    },
    select: {
      vendor: true,
      dailyPrice: true,
      effectiveDailyPrice: true,
      pickupDate: true,
      observedAt: true,
    },
  });

  // See note in getMarketSummary — we use effectiveDailyPrice as the primary
  // number (total / lor = real all-in daily cost), falling back to dailyPrice
  // for legacy rows that didn't capture it.
  const priceOf = (o) =>
    o.effectiveDailyPrice != null ? Number(o.effectiveDailyPrice) : Number(o.dailyPrice);

  // Group by date (YYYY-MM-DD using observedAt) → array of {vendor, price}
  const byDate = new Map();
  for (const o of obs) {
    const day = o.observedAt.toISOString().slice(0, 10);
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day).push({ vendor: o.vendor || '?', price: priceOf(o) });
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
  for (const o of obs) {
    const v = (o.vendor || '?').trim();
    vendorCounts.set(v, (vendorCounts.get(v) || 0) + 1);
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
 * Dashboard-level Excel export (discoverable from /market): resolves the latest scrape
 * run for the airport's active profiles and reuses the per-run comparison workbook
 * (prices + suggested by vehicle class & day). Returns { buffer, filename }.
 */
export async function buildAirportExportWorkbook({ airport, scope = {} }) {
  if (!airport) {
    const err = new Error('airport query param is required'); err.httpStatus = 400; throw err;
  }
  const profileWhere = {
    locationCode: String(airport).toUpperCase(),
    active: true,
    ...(scope.tenantId === '__no_tenant__'
      ? { tenantId: '__no_tenant__' }
      : scope.tenantId ? { tenantId: scope.tenantId } : {}),
  };
  const profiles = await prisma.marketScrapeProfile.findMany({ where: profileWhere, select: { id: true } });
  if (profiles.length === 0) {
    const err = new Error('No market profile for this airport yet'); err.httpStatus = 404; throw err;
  }
  const profileIds = profiles.map((p) => p.id);
  // The run of the most recent FOUND observation across these profiles = latest run with data.
  const latest = await prisma.marketObservation.findFirst({
    where: { profileId: { in: profileIds }, status: 'FOUND', runId: { not: null } },
    orderBy: { observedAt: 'desc' },
    select: { runId: true },
  });
  if (!latest?.runId) {
    const err = new Error('No scrape run with data for this airport yet'); err.httpStatus = 404; throw err;
  }
  return buildRunComparisonWorkbook(latest.runId, { scope });
}

export const marketObservationsService = {
  getMarketSummary,
  getMarketHistory,
  buildAirportExportWorkbook,
};
