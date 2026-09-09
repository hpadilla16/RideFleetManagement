/**
 * The self-check, over real scrape data (2026-09-09).
 *
 * `price-self-check.js` holds the judgement and is pure. This is the part that
 * has to touch the database: pull the last N days of offers for a sede, split
 * them into OURS and THEIRS, apply the profile's own strategy to get the
 * target, and hand each cell to `evaluateCell`.
 *
 * ── WHOSE LISTINGS ARE OURS ─────────────────────────────────────────────────
 * `Tenant.marketExcludedVendors` is already the list of our own brands — it is
 * how the engine avoids undercutting itself. It is reused here rather than
 * duplicated, which also means the two can never drift apart and start
 * disagreeing about who we are.
 *
 * Per-franchise attribution uses the same list, matched one alias at a time,
 * so the report can say WHICH brand is off rather than only that some brand is.
 *
 * ── THE TARGET IS THE PROFILE'S OWN RULE ────────────────────────────────────
 * Not a number invented here. CHEAPEST_MINUS_AMOUNT with strategyAmount = 1 is
 * what Corpusa's LAX profiles carry, so the target is the cheapest competitor
 * minus a dollar, and a profile with a different rule is judged by that rule.
 * Inventing an anchor is exactly the mistake Hector corrected in July.
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';
import { vendorKey } from './market-vendor.js';
import { evaluateCell, summarize, DEFAULT_TOLERANCE, DEFAULT_MIN_SAMPLE } from './price-self-check.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * Apply a profile's configured strategy to the cheapest competitor price.
 * PURE. Returns null when there is no competitor to anchor on, or the strategy
 * is one this does not model — never a guessed number.
 */
export function targetFromStrategy(cheapest, profile) {
  const base = Number(cheapest);
  if (!Number.isFinite(base) || base <= 0 || !profile) return null;
  const amount = Number(profile.strategyAmount);
  const pct = Number(profile.strategyPct);
  let out = null;
  switch (String(profile.strategy || '').toUpperCase()) {
    case 'CHEAPEST_MINUS_AMOUNT':
      if (Number.isFinite(amount)) out = base - amount;
      break;
    case 'CHEAPEST_MINUS_PCT':
      if (Number.isFinite(pct)) out = base * (1 - pct / 100);
      break;
    case 'MATCH_CHEAPEST':
      out = base;
      break;
    default:
      return null;
  }
  if (out == null || !Number.isFinite(out)) return null;
  const floor = Number(profile.strategyFloor);
  if (Number.isFinite(floor) && floor > 0 && out < floor) out = floor;
  return out > 0 ? round2(out) : null;
}

/**
 * Run the check for one sede.
 *
 * @param {object} scope        { tenantId }
 * @param {object} opts
 * @param {string} opts.locationCode   the profile's location code (AIRPORT code)
 * @param {number} [opts.days]         how far back to read observations
 * @param {object} [opts.prisma]
 * @returns {Promise<object>} { locationCode, strategy, summary, cells, brands }
 */
export async function runSelfCheck(scope, opts = {}) {
  const db = opts.prisma || defaultPrisma;
  const tenantId = scope?.tenantId;
  const locationCode = String(opts.locationCode || '').trim().toUpperCase();
  if (!tenantId || !locationCode) {
    const e = new Error('tenantId and locationCode are required');
    e.httpStatus = 400;
    throw e;
  }
  const days = Number.isFinite(Number(opts.days)) && Number(opts.days) > 0
    ? Math.min(Number(opts.days), 30) : 3;
  const tolerance = Number.isFinite(Number(opts.tolerance)) ? Number(opts.tolerance) : DEFAULT_TOLERANCE;
  const minSample = Number.isFinite(Number(opts.minSample)) ? Number(opts.minSample) : DEFAULT_MIN_SAMPLE;

  const profiles = await db.marketScrapeProfile.findMany({
    where: { tenantId, locationCode, active: true },
    select: {
      id: true, name: true, strategy: true, strategyAmount: true,
      strategyPct: true, strategyFloor: true,
    },
  });
  if (!profiles.length) {
    return {
      locationCode, days, strategy: null, ourBrands: [],
      summary: summarize([]), cells: [], brands: {},
      note: 'No active Market Intelligence profile for this location code.',
    };
  }
  // Every profile at one sede shares a rule in practice; the first is the one
  // reported, and a mismatch is surfaced rather than silently averaged.
  const profile = profiles[0];
  const mixedStrategy = profiles.some((p) => p.strategy !== profile.strategy);

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId }, select: { marketExcludedVendors: true },
  });
  const ourNames = Array.isArray(tenant?.marketExcludedVendors) ? tenant.marketExcludedVendors : [];
  const ourKeys = new Set(ourNames.map(vendorKey).filter(Boolean));

  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const offers = await db.rateOffer.findMany({
    where: {
      profileId: { in: profiles.map((p) => p.id) },
      status: 'FOUND',
      observedAt: { gt: since },
    },
    select: {
      supplier: true, sipp: true, pickupDate: true,
      dailyPrice: true, effectiveDailyPrice: true,
    },
  });

  // Fold into (date, class) cells. Cheapest per side; competitor DEPTH counted
  // by distinct supplier, because ten listings from one company is still one
  // company and the ladder is a ladder of companies.
  const cells = new Map();
  for (const o of offers) {
    const price = Number(o.effectiveDailyPrice ?? o.dailyPrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    const date = o.pickupDate instanceof Date
      ? o.pickupDate.toISOString().slice(0, 10) : String(o.pickupDate).slice(0, 10);
    const sipp = String(o.sipp || '').toUpperCase();
    if (!sipp) continue;
    const key = `${date}|${sipp}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { date, sipp, ours: null, rival: null, rivalName: null, rivals: new Set(), byBrand: {} };
      cells.set(key, cell);
    }
    const k = vendorKey(o.supplier);
    if (k && ourKeys.has(k)) {
      if (cell.ours == null || price < cell.ours) cell.ours = price;
      const prior = cell.byBrand[o.supplier];
      if (prior == null || price < prior) cell.byBrand[o.supplier] = price;
    } else {
      cell.rivals.add(k || String(o.supplier));
      if (cell.rival == null || price < cell.rival) { cell.rival = price; cell.rivalName = o.supplier; }
    }
  }

  const judged = [];
  for (const cell of cells.values()) {
    const target = targetFromStrategy(cell.rival, profile);
    judged.push({
      date: cell.date,
      sipp: cell.sipp,
      target,
      rival: cell.rival,
      rivalName: cell.rivalName,
      byBrand: cell.byBrand,
      ...evaluateCell({
        ours: cell.ours, target, cheapestCompetitor: cell.rival,
        rivalCount: cell.rivals.size, tolerance, minSample,
      }),
    });
  }
  judged.sort((a, b) => (a.date === b.date ? a.sipp.localeCompare(b.sipp) : a.date.localeCompare(b.date)));

  // Per brand, the average signed gap — which brand is off, not just that one is.
  const brands = {};
  for (const c of judged) {
    if (c.target == null) continue;
    for (const [name, price] of Object.entries(c.byBrand || {})) {
      const b = (brands[name] ||= { cells: 0, sumGap: 0, avgGap: 0 });
      b.cells += 1;
      b.sumGap = round2(b.sumGap + (price - c.target));
    }
  }
  for (const b of Object.values(brands)) b.avgGap = b.cells ? round2(b.sumGap / b.cells) : 0;

  return {
    locationCode,
    days,
    profile: { id: profile.id, name: profile.name, strategy: profile.strategy, amount: profile.strategyAmount },
    mixedStrategy,
    ourBrands: ourNames,
    summary: summarize(judged),
    cells: judged,
    brands,
  };
}
