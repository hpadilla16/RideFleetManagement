import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import { settingsService } from '../settings/settings.service.js';
import { loadCompetitorRows } from '../market-scraper/rate-offer-source.js';
import { vendorKey } from '../market-scraper/market-vendor.js';
import { competitorAllIn, competitorAllInBasis, baseFromCustomerAllIn, customerAllInFromBase } from '../market-scraper/pricing-grossup.js';
import { getCompetitorExcludeSet } from '../market-scraper/market-scrape-comparison.service.js';
import { isExcludedVendor } from '../market-scraper/market-vendor.js';
import { splitSelfAndRivals, measureSelfBaseRatio, latestPerSupplier } from '../market-observations/self-position.js';
import { recommendBaseForTarget, targetSentence } from '../market-observations/window-target.js';
import { getEngineAManagedRateIds } from '../market-scraper/market-scrape-correction.service.js';
import { pickUtilizationTier, resolveTierTarget } from '../market-scraper/pricing-tiers.js';
import { buildUtilizationLookup } from '../market-scraper/pricing-utilization.js';

/**
 * Pricing Suggestion Engine
 * --------------------------
 * Runs after the daily Browserbase scrape completes. For every active
 * PricingRule, fetches the latest MarketObservation rows for the rule's
 * Rate (matched via the Rate's MarketScrapeProfile and the Rate's SIPP
 * class), computes a target price per the rule's strategy, applies padding
 * and floor/ceiling guardrails, and writes a PricingSuggestion.
 *
 * If the rule is AUTO mode and the resulting delta is within autoMaxDeltaPct,
 * the suggestion is written with status=AUTO_APPLIED and the Rate.daily is
 * updated in the same transaction.
 *
 * Spec: doc/market-intelligence-plan-2026-06-05.md
 */

const SUGGESTION_TTL_MS = 48 * 60 * 60 * 1000; // 48h

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round((v + Number.EPSILON) * 100) / 100 : null;
}

/**
 * The location's tax/fee config, used for BOTH halves of the comparison: to
 * lift competitor quotes to the all-in their customer pays, and to back-solve
 * the base this tenant must upload to land on a chosen all-in.
 *
 * Keyed on the Rate's location CODE, which is how every other MI read is keyed.
 * That is also the known IATA-vs-Location.code trap (Corpusa's branch is
 * LAXA01 while its config and profile are LAX): the lookup misses, the config
 * is null, the gross-up degrades to the identity, and the engine behaves
 * exactly as it did before any of this. Wrong, but never silently wrong in the
 * expensive direction -- and it cannot bite Corpusa today, which has no
 * PricingRule rows at all.
 */
async function resolvePricingConfig(rule, getPricingConfig = null) {
  // ALWAYS an object, never null: a default parameter only fires on
  // undefined, so passing an explicit null downstream would make
  // taxesFraction(null) throw on .taxes -- the same trap as Number(null).
  try {
    if (getPricingConfig) return (await getPricingConfig(rule)) || {};
    const row = await prisma.marketPricingConfig.findFirst({
      where: { tenantId: rule.tenantId, locationCode: rule.rate.location.code },
    });
    return row || {};
  } catch {
    // No config = identity gross-up = today's behavior. Never go dark.
    return {};
  }
}

/** Distinct agencies a cell must contain before a rule may move a live price. */
const DEFAULT_MIN_SAMPLE_VENDORS = 3;

/**
 * Minimum-sample guard (2026-09-02, mechanism only). How many DISTINCT
 * agencies (vendors) must be present in the cell — after the adapter's
 * purpose:'pricing' filters/gating — before a rule may act. Config lives in
 * the per-tenant marketPricingConfig AppSetting
 * (settingsService.getMarketPricingSampleConfig).
 *
 * DEFAULT 3 since 2026-09-10 (Hector). It was 1, which is the same as having
 * no guard: SJU's FCAR cell held 80 rows that were ONE supplier quoting ONE
 * Chevrolet Malibu, and LFAR was ten rows from a single agency — both passed a
 * floor of one and both were free to move a live online price. Three distinct
 * agencies is the same floor `price-self-check.js` already uses, so the two
 * subsystems now agree on what counts as a market. A config-read failure still
 * falls back to the default rather than going dark.
 */
async function resolveMinSampleVendors(tenantId, getMinSampleConfig = null) {
  try {
    const cfg = await (getMinSampleConfig
      ? getMinSampleConfig({ tenantId })
      : settingsService.getMarketPricingSampleConfig({ tenantId }));
    const n = Number(cfg?.minSampleVendors);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  } catch { /* default below */ }
  return DEFAULT_MIN_SAMPLE_VENDORS;
}

// ---------------------------------------------------------------------------
// Utilization lift (Hector, 2026-08-06: "asegurate que los precios de MI esten
// mirando utilization rate y que estan subiendo basado de los settings").
//
// The tenant's MarketPricingConfig.utilizationRules — the same tier ladder the
// market-comparison screen resolves (pricing-tiers.js) — now applies to THIS
// engine, the one that actually writes Rate.daily. As projected utilization
// rises, the tier moves the target up the competitive ladder (3rd cheapest →
// 5th → market median → median+15% → …).
//
// ONE deliberate divergence from the comparison screen: there the tier REPLACES
// the base target; here it can only RAISE it. A fleet that is filling up must
// never price BELOW what the competitive strategy already chose — a tier table
// with a low rung would otherwise cut prices exactly when scarcity says not to.
// ---------------------------------------------------------------------------

/**
 * Pure. Lift a padded strategy price by the utilization tier, never lowering it.
 * Returns { price, utilization, tier, lifted }.
 */
export function applyUtilizationLift({ paddedPrice, pricesAsc, utilization, rules }) {
  const base = Number(paddedPrice);
  const none = { price: base, utilization: utilization ?? null, tier: null, lifted: false };
  if (!Number.isFinite(base) || utilization == null || !Array.isArray(rules) || rules.length === 0) return none;
  const tier = pickUtilizationTier(utilization, rules);
  if (!tier) return none;
  const tierTarget = resolveTierTarget(tier, pricesAsc);
  if (tierTarget == null || tierTarget <= base) {
    return { price: base, utilization, tier, lifted: false };
  }
  return { price: tierTarget, utilization, tier, lifted: true };
}

/**
 * Per-run cache of (tenant, location) → { rules, lookup }. Building the
 * utilization lookup runs the availability-forecast math, so it is done once
 * per location per engine run, not once per rule.
 */
/**
 * Pure. The lookup window for "today's utilization". The forecast window
 * EXCLUDES its `to` day, so from == to is a ZERO-DAY window and every
 * utilOf() answers null. Found on the first nightly run (2026-08-06 04:51):
 * the whole chain worked, but every suggestion carried utilization n/a — the
 * lift was silently dark. One day past today is the narrowest window that
 * contains today.
 */
export function utilizationLookupWindow(now = new Date()) {
  const t = now.getTime();
  return {
    todayISO: new Date(t).toISOString().slice(0, 10),
    fromISO: new Date(t).toISOString().slice(0, 10),
    toISO: new Date(t + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  };
}

function createUtilizationContext() {
  const entries = new Map();
  const { todayISO, toISO: tomorrowISO } = utilizationLookupWindow();
  return {
    async utilizationFor(tenantId, locationCode, sipp) {
      if (!tenantId || !locationCode) return { utilization: null, rules: [] };
      const key = `${tenantId}|${locationCode}`;
      if (!entries.has(key)) {
        entries.set(key, (async () => {
          const config = await prisma.marketPricingConfig.findUnique({
            where: { tenantId_locationCode: { tenantId, locationCode } },
            select: { utilizationRules: true },
          }).catch(() => null);
          const rules = Array.isArray(config?.utilizationRules) ? config.utilizationRules : [];
          if (!rules.length) return { rules, lookup: null };
          const lookup = await buildUtilizationLookup({
            tenantId, locationCode, fromISO: todayISO, toISO: tomorrowISO,
          });
          return { rules, lookup };
        })());
      }
      const { rules, lookup } = await entries.get(key);
      return {
        rules,
        utilization: lookup && sipp ? lookup.utilOf(sipp, todayISO) : null,
      };
    },
  };
}

/**
 * Top-level orchestrator. Iterates all active rules across all tenants,
 * evaluates each. Used by the cron endpoint /api/internal/pricing-engine/run.
 *
 * Returns { rulesEvaluated, suggestionsPending, suggestionsAutoApplied, errors[] }.
 */
export async function runPricingEngine({ rateIds = null, tenantId = null } = {}) {
  // Defense in depth: a tenant whose super-admin disabled marketIntelligence
  // should NOT produce new suggestions, even if their PricingRule rows were
  // left active=true by mistake. The cascade in tenants.service.js handles
  // the normal path; this filter catches drift (e.g. flag was disabled
  // before the cascade existed, or the cascade failed mid-transaction).
  const where = {
    active: true,
    tenant: { marketIntelligenceEnabled: true }
  };
  if (rateIds) where.rateId = { in: rateIds };
  if (tenantId) where.tenantId = tenantId;

  const rules = await prisma.pricingRule.findMany({
    where,
    include: {
      rate: {
        select: {
          id: true,
          tenantId: true,
          rateCode: true,
          daily: true,
          locationId: true,
          location: { select: { id: true, code: true } },
        },
      },
    },
  });

  const out = { rulesEvaluated: 0, suggestionsPending: 0, suggestionsAutoApplied: 0, suggestionsSkipped: 0, suggestionsRetired: 0, errors: [] };

  // One engine per rate. When Market Intelligence auto-apply (Engine A) OWNS a
  // rate and is actually able to write it (master switch on + autoApply profile +
  // fully-configured guardrails), Engine B (PricingRule) must NOT also write that
  // rate — Engine A's per-date RateDailyPrice override would otherwise mask B's
  // Rate.daily base. When the master switch is off (DARK), this set is empty and
  // Engine B behaves exactly as before. See getEngineAManagedRateIds().
  const engineAManaged = await getEngineAManagedRateIds({ tenantId });

  // First, expire stale PENDING suggestions older than TTL.
  await prisma.pricingSuggestion.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });

  // Shared per-run utilization context (config + forecast math once per location).
  const utilizationContext = createUtilizationContext();

  // Min-sample config memoized per tenant for the run (one AppSetting read per
  // tenant, not one per rule).
  const minSampleCache = new Map();
  const getMinSampleConfig = ({ tenantId: tid }) => {
    if (!minSampleCache.has(tid)) {
      minSampleCache.set(tid, settingsService.getMarketPricingSampleConfig({ tenantId: tid }));
    }
    return minSampleCache.get(tid);
  };

  for (const rule of rules) {
    out.rulesEvaluated += 1;
    if (engineAManaged.has(rule.rateId)) {
      // Retired in favor of Engine A for this rate.
      out.suggestionsRetired += 1;
      continue;
    }
    try {
      const result = await evaluateRule(rule, { utilizationContext, getMinSampleConfig });
      if (result.skipped) {
        out.suggestionsSkipped += 1;
        continue;
      }
      if (result.autoApplied) out.suggestionsAutoApplied += 1;
      else out.suggestionsPending += 1;
    } catch (err) {
      out.errors.push({ ruleId: rule.id, message: err.message });
    }
  }

  return out;
}

/**
 * SHADOW MODE (2026-09-10). Computes what the window-target engine WOULD
 * recommend, and returns it for the audit payload. It changes nothing: the
 * number this rule writes is still the one the live path computed.
 *
 * It exists because the live path was measured this day to deliver the tenant's
 * configured target on 0 of 14 classes, and the only responsible way to replace
 * a money path that has been wrong for weeks is to run the replacement beside
 * it first, on real pools, where both answers can be compared before either
 * moves a price.
 *
 * Two differences from the live path, and they are the whole point:
 *   - the ladder is per PICKUP DATE (the 24h window at SJU spans fifty of them,
 *     and collapsing them with a MIN prices for the cheapest day in the window)
 *   - the base is derived with the ratio MEASURED from the tenant's own listing
 *     on the OTA, not with the tax gross-up
 */
async function shadowWindowTarget(rule, obs, { sipp, targetN, paddingPct }) {
  try {
    const excludeSet = await getCompetitorExcludeSet(rule.tenantId);
    const rows = obs.map((o) => ({
      supplier: o.vendor,
      price: o.effectiveDailyPrice != null ? Number(o.effectiveDailyPrice) : Number(o.dailyPrice),
      observedAt: o.observedAt,
      pickupDate: o.pickupDate,
    }));
    const { self, rivals } = splitSelfAndRivals(rows, (s) => isExcludedVendor(s, excludeSet));

    const laddersByDate = new Map();
    for (const d of [...new Set(rivals.map((r) => (r.pickupDate ? new Date(r.pickupDate).toISOString().slice(0, 10) : null)).filter(Boolean))].sort()) {
      laddersByDate.set(d, latestPerSupplier(rivals.filter((r) => r.pickupDate && new Date(r.pickupDate).toISOString().slice(0, 10) === d)));
    }

    const ratio = measureSelfBaseRatio(self, Number(rule.rate.daily));
    const rec = recommendBaseForTarget({
      laddersByDate,
      targetN,
      ratio: ratio.median,
      floor: Number(rule.floorPrice),
      ceiling: Number(rule.ceilingPrice),
      paddingPct,
    });
    return {
      ...rec,
      sipp,
      selfListingsSeen: self.length,
      ratio,
      sentence: targetSentence(rec, { asOf: obs.length ? obs[obs.length - 1].observedAt : null }),
    };
  } catch (e) {
    // A shadow computation must never affect the live one, including by
    // throwing. Its absence is visible in the payload; a 500 would not be.
    return { error: e.message };
  }
}

/**
 * Evaluate a single rule. Returns:
 *   { skipped: true, reason }  — no observations / MANUAL strategy / etc
 *   { skipped: false, autoApplied: true|false, suggestionId, ... }
 *
 * Pure logic + a single PricingSuggestion write (+ optional Rate.daily
 * update for AUTO mode). Safe to retry.
 */
export async function evaluateRule(rule, { utilizationContext = null, getMinSampleConfig = null, getPricingConfig = null } = {}) {
  if (rule.strategy === 'MANUAL') {
    return { skipped: true, reason: 'manual_rule_no_op' };
  }
  if (!rule.rate) {
    return { skipped: true, reason: 'rate_not_found' };
  }
  if (!rule.rate.location?.code) {
    return { skipped: true, reason: 'rate_has_no_location_code' };
  }

  // Resolve which SIPP class this Rate competes in.
  //
  // Preferred path: rule.sipp is set explicitly (multi-SIPP tenants where
  // one scrape profile covers many SIPP classes). The engine just reads
  // the column and uses the Rate's location for the airport code.
  //
  // Fallback path: rule.sipp is null (legacy / single-SIPP tenants) — we
  // ask resolveSippForRate to pick the most-observed SIPP from the profile
  // that targets this Rate via targetRateId. That keeps backward compat
  // with rows created before this column existed.
  let sippInfo;
  if (rule.sipp && rule.rate?.location?.code) {
    sippInfo = { sipp: rule.sipp, locationCode: rule.rate.location.code };
  } else {
    sippInfo = await resolveSippForRate(rule.rate);
  }
  if (!sippInfo) {
    return { skipped: true, reason: 'no_observed_sipp_for_rate' };
  }
  const { sipp, locationCode } = sippInfo;

  // Fetch latest 24h competitor rows for that SIPP+location. Dual-read
  // (RateOffer + legacy MarketObservation) through the adapter with
  // purpose:'pricing': only sources CONFIRMED all-in survive
  // (sourceAllInConfirmed allowlist — KAYAK stays out until
  // KAYAK_EFFECTIVE_IS_ALL_IN=true because its effectiveDailyPrice is a
  // fee-less teaser, and any unvetted future source stays out by default) —
  // this engine writes REAL prices (15 AUTO rules live); see
  // rate-offer-source.js for the full rationale (2026-07-03 / 2026-09-02).
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { rows: obs } = await loadCompetitorRows(
    prisma,
    { sipp, observedSince: since, profile: { locationCode, tenantId: rule.tenantId } },
    { purpose: 'pricing' }
  );
  if (obs.length === 0) {
    return { skipped: true, reason: 'no_recent_observations' };
  }

  // Pricing computation uses effectiveDailyPrice (= totalPrice / lorDays) —
  // the apples-to-apples all-in daily cost vs Rate Highway's model. The
  // dailyPrice teaser is misleading because Expedia layers ~30-50% in taxes
  // and fees on top. Falls back to dailyPrice for legacy rows.
  const priceOf = (o) =>
    o.effectiveDailyPrice != null ? Number(o.effectiveDailyPrice) : Number(o.dailyPrice);

  // Compute per-vendor min (one vendor may have multiple pickup-date rows).
  //
  // Keyed on the CANONICAL vendor key, not the display name (2026-09-10). The
  // feed spells one agency several ways — "U-Save" and "U-Save Car Rental" —
  // and grouping by the raw string counted them as two distinct competitors.
  // That inflated the ladder and, worse, let a single agency clear the
  // minimum-sample floor by itself, which is the one thing the floor exists to
  // prevent. The display name of the cheapest row is kept for the reason
  // payload, so nothing a human reads changes.
  const perVendor = new Map();
  for (const o of obs) {
    const display = (o.vendor || '?').trim();
    const key = vendorKey(display) || display.toLowerCase();
    const price = priceOf(o);
    const prev = perVendor.get(key);
    if (prev == null || price < prev.price) perVendor.set(key, { vendor: display, price, observationId: o.id });
  }
  // Minimum-sample guard: perVendor.size is the number of DISTINCT agencies in
  // this cell after every existing filter (24h window, SIPP+location, adapter
  // purpose:'pricing' all-in gate, anonymous-supplier exclusion). Below the
  // tenant's floor the market signal is too thin to act on — skip, same idiom
  // as 'no_recent_observations'. Default floor 1 keeps today's behavior bit-
  // for-bit (obs.length > 0 implies at least one vendor).
  const minSampleVendors = await resolveMinSampleVendors(rule.tenantId, getMinSampleConfig);
  if (perVendor.size < minSampleVendors) {
    return { skipped: true, reason: 'below_min_sample' };
  }

  // ALL-IN vs ALL-IN, then recommend the BASE (2026-09-10, Hector: "que veamos
  // la competencia pero todavia recomienda el precio que ellos tienen que poner
  // en sus integraciones para reflejar ese precio que ve el cliente").
  //
  // The competitor rows are QUOTES -- Kayak's number is a teaser, measured that
  // day at 0.582x Expedia's all-in. Lift them to what their customer actually
  // pays, choose a position on THAT ladder, and back-solve the base to upload.
  // Without a tax layer configured the lift is the identity and everything
  // below behaves exactly as it did before.
  const pricingConfig = await resolvePricingConfig(rule, getPricingConfig);
  const allInBasis = competitorAllInBasis(pricingConfig);
  const ordered = Array.from(perVendor.values())
    .map((r) => ({ ...r, quoted: r.price, price: competitorAllIn(r.price, pricingConfig) }))
    .sort((a, b) => a.price - b.price);
  const prices = ordered.map((r) => r.price);
  const marketMin = prices[0];
  const marketMedian = prices[Math.floor(prices.length / 2)];

  // Compute strategy target.
  let targetPrice = null;
  let guardrailsHit = [];
  let strategyReason = {};

  if (rule.strategy === 'NTH_CHEAPEST') {
    const n = Math.max(1, Math.min(10, rule.targetN || 1));
    const targetRow = ordered[n - 1] || ordered[ordered.length - 1];
    targetPrice = targetRow.price;
    strategyReason = { targetN: n, targetRow };
  } else if (rule.strategy === 'CHASE_VENDOR') {
    const needle = (rule.targetVendor || '').trim().toLowerCase();
    if (!needle) return { skipped: true, reason: 'chase_vendor_missing_target' };
    const match = ordered.find((r) => r.vendor.toLowerCase().includes(needle));
    if (!match) {
      // Vendor not in market right now — record an EXPIRED suggestion so the
      // operator can see why nothing happened, but don't apply anything.
      await prisma.pricingSuggestion.create({
        data: {
          ruleId: rule.id,
          tenantId: rule.tenantId,
          rateId: rule.rateId,
          currentPrice: rule.rate.daily,
          suggestedPrice: rule.rate.daily,
          deltaAmount: 0,
          deltaPct: 0,
          reason: {
            strategy: 'CHASE_VENDOR',
            error: 'target_vendor_not_observed',
            targetVendor: rule.targetVendor,
            marketVendorsSeen: ordered.map((r) => r.vendor),
          },
          status: 'EXPIRED',
          expiresAt: new Date(Date.now() + SUGGESTION_TTL_MS),
        },
      });
      return { skipped: true, reason: 'target_vendor_not_observed' };
    }
    targetPrice = match.price;
    strategyReason = { targetVendor: rule.targetVendor, matchedVendor: match.vendor, matchedPrice: match.price };
  }

  // Apply padding: padded = target * (1 + paddingPct/100)
  // Negative paddingPct = undercut. Positive = above target.
  const padPct = Number(rule.paddingPct ?? 0);
  let priced = targetPrice * (1 + padPct / 100);

  // Utilization lift: as the fleet fills, the tenant's tier ladder
  // (MarketPricingConfig.utilizationRules) moves the target UP the competitive
  // ladder — never down. Today's projected utilization for this SIPP, computed
  // with the same math as the Availability Forecast report.
  let utilizationInfo = { utilization: null, tier: null, lifted: false };
  if (utilizationContext) {
    const { utilization, rules: utilRules } = await utilizationContext
      .utilizationFor(rule.tenantId, rule.rate.location.code, sipp);
    utilizationInfo = applyUtilizationLift({
      paddedPrice: priced, pricesAsc: prices, utilization, rules: utilRules,
    });
    priced = utilizationInfo.price;
  }

  // Everything above is the ALL-IN the customer should see. What the tenant
  // types into the integration is the BASE that grosses up to it, so back-solve
  // before the bounds: rule.floorPrice / rule.ceilingPrice are BASE bounds (a
  // $69.66 floor against a $115 base), and clamping an all-in number against
  // them would compare two different currencies.
  const targetAllIn = priced;
  priced = baseFromCustomerAllIn(priced, pricingConfig);

  // Clamp to floor/ceiling.
  const floor = Number(rule.floorPrice);
  const ceiling = Number(rule.ceilingPrice);
  if (priced < floor) { priced = floor; guardrailsHit.push('floor'); }
  if (priced > ceiling) { priced = ceiling; guardrailsHit.push('ceiling'); }

  // Round to 2 decimals.
  const suggestedPrice = Math.round(priced * 100) / 100;
  const currentPrice = Number(rule.rate.daily);
  const deltaAmount = Math.round((suggestedPrice - currentPrice) * 100) / 100;
  const deltaPct = currentPrice === 0 ? 0 : Math.round((deltaAmount / currentPrice) * 10000) / 100; // 2 decimals

  // Decide auto-apply vs pending.
  const autoCap = rule.autoMaxDeltaPct == null ? null : Number(rule.autoMaxDeltaPct);
  const withinAutoCap = autoCap == null ? true : Math.abs(deltaPct) <= autoCap;
  const willAutoApply = rule.mode === 'AUTO' && withinAutoCap;
  if (rule.mode === 'AUTO' && !withinAutoCap) guardrailsHit.push('autoMaxDelta');

  // Compute your rank (using the proposed price) so the inbox can show it.
  const yourRank = ordered.findIndex((r) => r.price > suggestedPrice) + 1 || ordered.length + 1;

  const reason = {
    strategy: rule.strategy,
    ...strategyReason,
    paddingPct: padPct,
    marketMin,
    marketMedian,
    // What the per-pickup-date engine would have said. Recorded, never applied.
    shadow: await shadowWindowTarget(rule, obs, {
      sipp,
      targetN: rule.strategy === 'NTH_CHEAPEST' ? Math.max(1, Math.min(10, rule.targetN || 1)) : 1,
      paddingPct: padPct,
    }),
    // The money trail for the two-domain math: what the rivals were QUOTED at,
    // what their customer pays, the all-in we aimed for, and the all-in our own
    // recommendation implies. `basis` says how the lift was computed.
    priceBasis: allInBasis.basis,
    competitorFactor: allInBasis.factor,
    competitorFlatPerDay: allInBasis.flat,
    marketMinQuoted: ordered.length ? ordered[0].quoted : null,
    targetAllIn: round2(targetAllIn),
    suggestedAllIn: round2(customerAllInFromBase(suggestedPrice, pricingConfig)),
    marketVendorCount: ordered.length,
    yourRankAfter: yourRank,
    guardrailsHit,
    // The money trail for the utilization lift: what the fleet looked like and
    // which tier (if any) moved the price. utilization is 0..1; null = no
    // config / no capacity data — behavior identical to before the lift.
    utilization: utilizationInfo.utilization ?? null,
    utilizationTier: utilizationInfo.tier || null,
    utilizationLifted: utilizationInfo.lifted === true,
    observationIds: Array.from(perVendor.values()).map((r) => r.observationId),
  };

  // Write the suggestion (and optionally apply it).
  if (willAutoApply && deltaAmount !== 0) {
    const [suggestion] = await prisma.$transaction([
      prisma.pricingSuggestion.create({
        data: {
          ruleId: rule.id,
          tenantId: rule.tenantId,
          rateId: rule.rateId,
          currentPrice,
          suggestedPrice,
          deltaAmount,
          deltaPct,
          reason,
          status: 'AUTO_APPLIED',
          appliedAt: new Date(),
          expiresAt: new Date(Date.now() + SUGGESTION_TTL_MS),
        },
      }),
      prisma.rate.update({
        where: { id: rule.rateId },
        data: { daily: suggestedPrice },
      }),
      // RateItem.daily mirror — resolveForRental (rates.service.js:817)
      // reads `item?.daily ?? chosen.daily`, so RateItem wins over Rate.
      // After the 2026-06-07 switchover, every engine-controlled rate has
      // exactly one RateItem (Rate↔VehicleType 1:1 in the engine path),
      // so updateMany on rateId rewrites the operative price the booking
      // engine actually quotes. Without this, AUTO_APPLY would silently
      // no-op for booking quotes — see session-handoff 2026-06-07 for
      // the bug that caused this code to be added.
      prisma.rateItem.updateMany({
        where: { rateId: rule.rateId },
        data: { daily: suggestedPrice },
      }),
    ]);

    // After Rate.daily changes, the booking-engine's quote caches
    // (`t:${tenantId}:booking:bootstrap:...` and
    //  `t:${tenantId}:public:searchRental:...` — see
    // booking-engine.service.js lines 1055 + 1266) hold stale prices for
    // up to 5 minutes. Blanket-invalidate the tenant's cached namespaces
    // so new quote requests hit Prisma fresh. Existing reservations are
    // unaffected because their prices were snapshotted to
    // `Reservation.dailyRate` + `ReservationPricingSnapshot` at booking
    // and never re-read from `Rate.daily` (see audit 2026-06-07).
    //
    // PricingSuggestion is the audit trail for the change itself — no
    // separate AuditLog needed (AuditLog requires reservationId which
    // doesn't apply here).
    cache.invalidate(`t:${rule.tenantId}:booking:`);
    cache.invalidate(`t:${rule.tenantId}:public:`);

    return { skipped: false, autoApplied: true, suggestionId: suggestion.id, suggestedPrice, deltaPct };
  }

  // Zero-delta or PENDING path — just write the suggestion.
  const status = deltaAmount === 0 ? 'EXPIRED' : 'PENDING';
  const suggestion = await prisma.pricingSuggestion.create({
    data: {
      ruleId: rule.id,
      tenantId: rule.tenantId,
      rateId: rule.rateId,
      currentPrice,
      suggestedPrice,
      deltaAmount,
      deltaPct,
      reason,
      status,
      expiresAt: new Date(Date.now() + SUGGESTION_TTL_MS),
    },
  });
  if (status === 'EXPIRED') return { skipped: true, reason: 'zero_delta' };
  return { skipped: false, autoApplied: false, suggestionId: suggestion.id, suggestedPrice, deltaPct };
}

/**
 * Resolve which SIPP this Rate competes in.
 *
 * Strategy: look up MarketScrapeProfile where targetRateId = rate.id. The
 * profile already knows the locationCode. For SIPP, take the most-observed
 * SIPP from the profile's recent observations. (Profiles typically scrape a
 * single SIPP class because Hector's rates are per-class.)
 *
 * Returns { sipp, locationCode } or null if nothing's been observed yet.
 */
async function resolveSippForRate(rate) {
  const profile = await prisma.marketScrapeProfile.findFirst({
    where: { targetRateId: rate.id, active: true },
    select: { id: true, locationCode: true },
  });
  if (!profile) return null;

  // Dual-read via the adapter (purpose:'pricing' — same gate as evaluateRule,
  // so SIPP resolution can't be driven by rows the pricing math won't see).
  // Note: the old query capped at 200 raw rows; the adapter returns the full
  // recent set, which only makes the most-observed-SIPP vote more accurate.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const { rows: recent } = await loadCompetitorRows(
    prisma,
    { profileId: profile.id, observedSince: since },
    { purpose: 'pricing' }
  );
  if (recent.length === 0) return null;

  const counts = new Map();
  for (const r of recent) counts.set(r.sipp, (counts.get(r.sipp) || 0) + 1);
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  return { sipp: top[0], locationCode: profile.locationCode };
}

export const pricingSuggestionEngine = { runPricingEngine, evaluateRule };
