/**
 * Comparison stage — read-only diff between market observations and the
 * tenant's current RateDailyPrice rows.
 *
 *   Cheapest competitor per (pickupDate, sipp)
 *   -> map sipp -> VehicleType.code (tenant-scoped)
 *   -> compare to RateDailyPrice.daily for that (rateId, vehicleTypeId, date)
 *   -> apply the profile's pricing strategy to produce a suggestedPrice
 *
 * Output is the input the Correction stage (B.4 part 2) consumes when
 * profile.autoApply === true, or what the UI renders as a diff table for
 * human review when autoApply === false.
 *
 * This service does NOT mutate anything. Persisting suggestions / writing
 * RateDailyPrice lives in market-scrape-correction.service.js.
 */
import { prisma } from '../../lib/prisma.js';
import { renderReportExcel } from '../reports/reports-export.js';
import { excludeSetFor, isExcludedVendor, normalizeVendorName } from './market-vendor.js';
import { baseFromCustomerAllIn } from './pricing-grossup.js';

/**
 * Tax-aware pricing config for a (tenant, location). Returns the row or null.
 * A location WITHOUT a config keeps the legacy behavior (no gross-up) — the
 * tax-aware path is strictly opt-in per location.
 */
export async function getMarketPricingConfig(tenantId, locationCode) {
  if (!tenantId || !locationCode) return null;
  try {
    return await prisma.marketPricingConfig.findUnique({
      where: { tenantId_locationCode: { tenantId, locationCode: String(locationCode).toUpperCase() } },
    });
  } catch { return null; }
}

/**
 * Build the competitor-exclusion Set for a tenant from its UI-configured list
 * (Tenant.marketExcludedVendors — the tenant's own brand(s) + any vendors they
 * don't want in the competitor pool, set from Settings → Market Intelligence).
 * Returns a Set<vendorKey>. Never throws — empty config → empty set (no filtering).
 */
export async function getCompetitorExcludeSet(tenantId) {
  let names = [];
  if (tenantId) {
    try {
      const t = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { marketExcludedVendors: true },
      });
      if (Array.isArray(t?.marketExcludedVendors)) names = t.marketExcludedVendors;
    } catch { /* no filtering */ }
  }
  return excludeSetFor(names);
}

function notFound(msg) {
  const e = new Error(msg);
  e.httpStatus = 404;
  throw e;
}

function badRequest(msg) {
  const e = new Error(msg);
  e.httpStatus = 400;
  throw e;
}

/**
 * Humanize a profile's pricing strategy into a RateHighway-style "Rule" label
 * (e.g. "Lowest - $1", "Match lowest", "Lowest + 5%", "Floor $25"). Used by the
 * Excel exports. `fallback` is shown when the profile/strategy is unknown.
 */
export function ruleLabelFor(profile, fallback = '-') {
  if (!profile) return fallback;
  const a = profile.strategyAmount != null ? Number(profile.strategyAmount) : 0;
  const p = profile.strategyPct != null ? Number(profile.strategyPct) : 0;
  const f = profile.strategyFloor != null ? Number(profile.strategyFloor) : 0;
  switch (profile.strategy) {
    case 'CHEAPEST_MINUS_AMOUNT': return `Lowest - $${a}`;
    case 'MATCH_CHEAPEST': return 'Match lowest';
    case 'CHEAPEST_PLUS_PCT': return `Lowest + ${p}%`;
    case 'STATIC_FLOOR': return `Floor $${f}`;
    default: return String(profile.strategy || fallback);
  }
}

/**
 * Apply the profile's pricing strategy to the cheapest competitor price.
 *   CHEAPEST_MINUS_AMOUNT -> cheapest - strategyAmount
 *   MATCH_CHEAPEST        -> cheapest (no discount)
 *   CHEAPEST_PLUS_PCT     -> cheapest * (1 + strategyPct/100)
 *   STATIC_FLOOR          -> max(cheapest, strategyFloor)
 *
 * The floor (when set) is also a defense-in-depth clamp: any strategy whose
 * arithmetic would push the suggestion below the floor is raised to it. This
 * mirrors the standalone CLI scraper's behavior so the migration to DB-driven
 * is a no-op semantically.
 *
 * Returns null when `cheapest` is not a usable number.
 */
export function applyStrategy(cheapest, profile) {
  if (cheapest == null || !Number.isFinite(Number(cheapest))) return null;
  const c = Number(cheapest);
  const amount = profile.strategyAmount != null ? Number(profile.strategyAmount) : 0;
  const pct = profile.strategyPct != null ? Number(profile.strategyPct) : 0;
  const floor = profile.strategyFloor != null ? Number(profile.strategyFloor) : 0;

  let suggested;
  switch (profile.strategy) {
    case 'CHEAPEST_MINUS_AMOUNT':
      suggested = c - amount;
      break;
    case 'MATCH_CHEAPEST':
      suggested = c;
      break;
    case 'CHEAPEST_PLUS_PCT':
      suggested = c * (1 + pct / 100);
      break;
    case 'STATIC_FLOOR':
      suggested = Math.max(c, floor);
      break;
    default:
      badRequest(`Unknown strategy: ${profile.strategy}`);
  }
  // Defense-in-depth: never go below floor when one is set.
  if (floor > 0 && suggested < floor) suggested = floor;
  return Number(suggested.toFixed(2));
}

/**
 * Group MarketObservation rows by (pickupDateISO, sipp) and pick the cheapest
 * dailyPrice in each bucket. Skips rows where:
 *   - status !== 'FOUND' (UNMAPPED / ERROR / CLOSED have no usable price)
 *   - dailyPrice is null
 * Returns Map<"YYYY-MM-DD|SIPP", {date, sipp, cheapest, vendor, sampled}>.
 */
export function aggregateCheapestBySippDate(observations, { excludeSet, useEffective = false } = {}) {
  const byKey = new Map();
  for (const obs of observations) {
    if (obs.status !== 'FOUND') continue;
    if (obs.dailyPrice == null) continue;
    // Drop the tenant's own brand / configured exclusions from the pool so we
    // never pick "ourselves" as the cheapest competitor.
    if (excludeSet && isExcludedVendor(obs.vendor, excludeSet)) continue;
    // Tax-aware path compares on the ALL-IN price (effectiveDailyPrice = total / LOR);
    // legacy path uses the teaser dailyPrice. Fallback keeps it safe for legacy rows.
    const raw = useEffective && obs.effectiveDailyPrice != null ? obs.effectiveDailyPrice : obs.dailyPrice;
    const price = Number(raw);
    if (!Number.isFinite(price) || price <= 0) continue;
    const dateISO = obs.pickupDate instanceof Date
      ? obs.pickupDate.toISOString().slice(0, 10)
      : String(obs.pickupDate).slice(0, 10);
    const vendor = normalizeVendorName(obs.vendor) || null;
    const key = `${dateISO}|${obs.sipp}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        date: dateISO,
        sipp: obs.sipp,
        cheapest: price,
        vendor,
        sampled: 1
      });
    } else {
      existing.sampled += 1;
      if (price < existing.cheapest) {
        existing.cheapest = price;
        existing.vendor = vendor;
      }
    }
  }
  return byKey;
}

/**
 * Compute the diff between a run's observations and the tenant's current
 * RateDailyPrice rows.
 *
 * @param {string} runId
 * @param {{scope: {tenantId?: string}}} opts
 * @returns {Promise<{
 *   profileId, runId, strategy,
 *   targetRateId, targetRateMissing,
 *   rows: Array<{
 *     date, sipp, vehicleTypeId|null, vehicleTypeMissing: bool,
 *     marketCheapest, marketVendor, marketSampled,
 *     currentPrice|null, suggestedPrice|null,
 *     deltaAbs|null, deltaPct|null,
 *     willUpdate: bool        // suggestedPrice != currentPrice (with > $0.01 threshold)
 *   }>,
 *   summary: { sampled, withCurrent, willUpdate, missingVehicleType }
 * }>}
 */
export async function computeRunComparison(runId, { scope = {} } = {}) {
  if (!runId) badRequest('runId required');

  // Load the run + its profile in one shot. We need both to apply the
  // strategy and look up the target Rate.
  const run = await prisma.marketScrapeRun.findFirst({
    where: { id: runId },
    include: { profile: true }
  });
  if (!run) notFound('Run not found');
  if (scope.tenantId && run.profile.tenantId !== scope.tenantId) {
    notFound('Run not found');
  }
  const profile = run.profile;

  // Load observations for the run.
  const observations = await prisma.marketObservation.findMany({
    where: { runId },
    orderBy: [{ pickupDate: 'asc' }, { sipp: 'asc' }]
  });

  const excludeSet = await getCompetitorExcludeSet(profile.tenantId);
  // Tax-aware pricing config (opt-in per location). When present, we compare on the
  // competitor ALL-IN price and back-solve the BASE rate to upload.
  const pricingConfig = await getMarketPricingConfig(profile.tenantId, profile.locationCode);
  const taxAware = !!pricingConfig;
  const byKey = aggregateCheapestBySippDate(observations, { excludeSet, useEffective: taxAware });

  // Without a targetRate, we still compute the suggestedPrice column so the
  // UI can show "this is what we'd charge", but currentPrice + delta are
  // blank. Callers see targetRateMissing=true so they can prompt for setup.
  let dailyPriceByKey = new Map(); // "YYYY-MM-DD|vehicleTypeId" -> currentPrice
  if (profile.targetRateId) {
    const allDates = [...new Set([...byKey.values()].map((r) => r.date))];
    const dates = allDates.map((d) => new Date(`${d}T00:00:00.000Z`));
    const prices = await prisma.rateDailyPrice.findMany({
      where: { rateId: profile.targetRateId, date: { in: dates } }
    });
    for (const p of prices) {
      const dISO = p.date.toISOString().slice(0, 10);
      dailyPriceByKey.set(`${dISO}|${p.vehicleTypeId}`, Number(p.daily));
    }
  }

  // SIPP -> VehicleType lookup (tenant-scoped). Cache in a Map so we don't
  // hit the DB once per (date, sipp) cell.
  const sippSet = new Set([...byKey.values()].map((r) => r.sipp));
  const vehicleTypes = profile.tenantId && sippSet.size > 0
    ? await prisma.vehicleType.findMany({
        where: { tenantId: profile.tenantId, code: { in: [...sippSet] } }
      })
    : [];
  const vehicleTypeBySipp = new Map();
  for (const vt of vehicleTypes) {
    vehicleTypeBySipp.set(vt.code, vt);
  }

  const rows = [];
  let withCurrent = 0;
  let willUpdate = 0;
  let missingVehicleType = 0;

  // Stable output order: by date asc, then by SIPP asc.
  const sortedKeys = [...byKey.keys()].sort();
  const floorBase = pricingConfig?.floorBase != null ? Number(pricingConfig.floorBase) : null;

  for (const key of sortedKeys) {
    const r = byKey.get(key);
    const vt = vehicleTypeBySipp.get(r.sipp) || null;
    // Apply the margin strategy to the cheapest competitor. In tax-aware mode
    // r.cheapest is the competitor ALL-IN, so this target is also an all-in.
    const target = applyStrategy(r.cheapest, profile);

    // suggested = the number we ACTUALLY upload (the base rate). In tax-aware mode
    // we back-solve the base from the target all-in via the location's gross-up,
    // then clamp to the per-location floor. Legacy mode uploads `target` as-is.
    let suggestedAllIn = null;
    let suggested = target;
    if (taxAware && target != null) {
      suggestedAllIn = target;
      let base = baseFromCustomerAllIn(target, pricingConfig);
      if (base != null && floorBase != null && base < floorBase) base = floorBase;
      suggested = base;
    }

    let currentPrice = null;
    if (vt && profile.targetRateId) {
      currentPrice = dailyPriceByKey.get(`${r.date}|${vt.id}`);
      if (currentPrice == null) currentPrice = null;
    }
    if (currentPrice != null) withCurrent += 1;
    if (!vt) missingVehicleType += 1;

    let deltaAbs = null;
    let deltaPct = null;
    let shouldUpdate = false;
    if (currentPrice != null && suggested != null) {
      deltaAbs = Number((suggested - currentPrice).toFixed(2));
      deltaPct = currentPrice !== 0
        ? Number(((suggested - currentPrice) / currentPrice * 100).toFixed(2))
        : null;
      // > 1¢ threshold guards against floating-point drift.
      shouldUpdate = Math.abs(deltaAbs) >= 0.01;
    }
    if (shouldUpdate) willUpdate += 1;

    rows.push({
      date: r.date,
      sipp: r.sipp,
      vehicleTypeId: vt?.id || null,
      vehicleTypeMissing: !vt,
      marketCheapest: r.cheapest,
      marketVendor: r.vendor,
      marketSampled: r.sampled,
      currentPrice,
      suggestedPrice: suggested,   // the BASE rate to upload (tax-aware) or the legacy suggestion
      suggestedAllIn,              // tax-aware: the target all-in the customer would see (else null)
      deltaAbs,
      deltaPct,
      willUpdate: shouldUpdate
    });
  }

  return {
    profileId: profile.id,
    runId,
    strategy: profile.strategy,
    targetRateId: profile.targetRateId || null,
    targetRateMissing: !profile.targetRateId,
    taxAware,
    pricingConfig: taxAware
      ? { connectionType: pricingConfig.connectionType, floorBase: floorBase ?? null }
      : null,
    rows,
    summary: {
      sampled: rows.length,
      withCurrent,
      willUpdate,
      missingVehicleType
    }
  };
}

/**
 * RateHighway-style Excel export for a run: prices + suggested amount BY vehicle
 * class (SIPP) and BY day. Reuses computeRunComparison + the shared exceljs helper.
 * Returns { buffer, filename }.
 */
export async function buildRunComparisonWorkbook(runId, { scope = {} } = {}) {
  const cmp = await computeRunComparison(runId, { scope });
  const rows = Array.isArray(cmp.rows) ? cmp.rows : [];

  let profileName = 'Market';
  let location = '';
  let strategyMeta = null;
  try {
    const run = await prisma.marketScrapeRun.findFirst({
      where: { id: runId },
      include: { profile: { select: {
        name: true, locationCode: true,
        strategy: true, strategyAmount: true, strategyPct: true, strategyFloor: true,
      } } },
    });
    if (run?.profile?.name) profileName = run.profile.name;
    if (run?.profile?.locationCode) location = String(run.profile.locationCode).toUpperCase();
    if (run?.profile) strategyMeta = run.profile;
  } catch { /* generic title */ }

  // RateHighway-style "Rule" label (e.g. "Lowest - $1").
  const ruleLabel = ruleLabelFor(strategyMeta, cmp.strategy || '-');

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const sipps = [...new Set(rows.map((r) => r.sipp))].sort();
  const byCell = new Map();
  for (const r of rows) byCell.set(`${r.sipp}|${r.date}`, r);
  const fmtDay = (d) => { const p = String(d).split('-'); return p.length === 3 ? `${p[1]}/${p[2]}` : String(d); };

  // Pivot: rows = vehicle class (SIPP), columns = each pickup day.
  const pivotCols = [
    { header: 'Vehicle class (SIPP)', key: 'sipp', width: 18 },
    ...dates.map((d) => ({ header: fmtDay(d), key: d, type: 'currency', width: 10 })),
  ];
  const pivot = (valueOf) => sipps.map((sipp) => {
    const out = { sipp };
    for (const d of dates) { const c = byCell.get(`${sipp}|${d}`); out[d] = c ? valueOf(c) : null; }
    return out;
  });
  const suggestedRows = pivot((c) => c.suggestedPrice ?? c.marketCheapest ?? null);
  const marketRows = pivot((c) => c.marketCheapest ?? null);

  // RateHighway-style flat sheet: one row per (pickup day × vehicle class), with the
  // cheapest competitor, our suggested price, current price and the difference. This is
  // the primary view (mirrors the RateHighway export Hector works from); the pivot sheets
  // below are supporting summaries.
  // In tax-aware mode "Comp. Rate" and "Suggested" are ALL-IN prices and we add an
  // "Uploaded Rate" column with the BASE rate that actually gets uploaded (RateHighway
  // shows both). Legacy mode keeps a single "Suggested" (= the uploaded number).
  const taxAware = !!cmp.taxAware;
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
    { header: 'Current Rate', key: 'currentPrice', type: 'currency', width: 12 },
    { header: 'Difference', key: 'deltaAbs', type: 'currency', width: 11 },
    { header: 'Samples', key: 'marketSampled', type: 'integer', width: 9 },
  ];
  const rhRows = rows.map((r) => ({
    date: r.date, location, sipp: r.sipp, rateCode: 'Daily', rule: ruleLabel,
    marketVendor: r.marketVendor || '', marketCheapest: r.marketCheapest ?? null,
    // Suggested column = all-in when tax-aware (suggestedAllIn), else the uploaded number.
    suggested: (taxAware ? r.suggestedAllIn : r.suggestedPrice) ?? null,
    uploadedBase: r.suggestedPrice ?? null,
    currentPrice: r.currentPrice ?? null,
    deltaAbs: r.deltaAbs ?? null, marketSampled: r.marketSampled ?? null,
  }));

  const range = dates.length ? `${dates[0]} - ${dates[dates.length - 1]}` : 'no dates';
  return renderReportExcel({
    title: `Market pricing - ${profileName}`,
    subtitle: `${location ? location + ' | ' : ''}Rule: ${ruleLabel} | ${range} | generated ${new Date().toISOString().slice(0, 10)}`,
    sheets: [
      { name: 'Pricing recommendations', columns: rhCols, rows: rhRows },
      { name: 'Suggested by class & day', columns: pivotCols, rows: suggestedRows },
      { name: 'Market cheapest', columns: pivotCols, rows: marketRows },
    ],
  });
}

export const marketScrapeComparisonService = {
  applyStrategy,
  aggregateCheapestBySippDate,
  computeRunComparison,
  buildRunComparisonWorkbook
};
