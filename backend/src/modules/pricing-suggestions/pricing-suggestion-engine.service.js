import { prisma } from '../../lib/prisma.js';

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

  const out = { rulesEvaluated: 0, suggestionsPending: 0, suggestionsAutoApplied: 0, suggestionsSkipped: 0, errors: [] };

  // First, expire stale PENDING suggestions older than TTL.
  await prisma.pricingSuggestion.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });

  for (const rule of rules) {
    out.rulesEvaluated += 1;
    try {
      const result = await evaluateRule(rule);
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
 * Evaluate a single rule. Returns:
 *   { skipped: true, reason }  — no observations / MANUAL strategy / etc
 *   { skipped: false, autoApplied: true|false, suggestionId, ... }
 *
 * Pure logic + a single PricingSuggestion write (+ optional Rate.daily
 * update for AUTO mode). Safe to retry.
 */
export async function evaluateRule(rule) {
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

  // Fetch latest 24h observations for that SIPP+location.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const obs = await prisma.marketObservation.findMany({
    where: {
      sipp,
      status: 'FOUND',
      dailyPrice: { not: null },
      observedAt: { gte: since },
      profile: { locationCode, tenantId: rule.tenantId },
    },
    select: {
      id: true,
      vendor: true,
      dailyPrice: true,
      effectiveDailyPrice: true,
      observedAt: true,
    },
  });
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
  const perVendor = new Map();
  for (const o of obs) {
    const v = (o.vendor || '?').trim();
    const price = priceOf(o);
    const prev = perVendor.get(v);
    if (prev == null || price < prev.price) perVendor.set(v, { vendor: v, price, observationId: o.id });
  }
  const ordered = Array.from(perVendor.values()).sort((a, b) => a.price - b.price);
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
    marketVendorCount: ordered.length,
    yourRankAfter: yourRank,
    guardrailsHit,
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
    ]);
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

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await prisma.marketObservation.findMany({
    where: { profileId: profile.id, observedAt: { gte: since }, status: 'FOUND' },
    select: { sipp: true },
    take: 200,
  });
  if (recent.length === 0) return null;

  const counts = new Map();
  for (const r of recent) counts.set(r.sipp, (counts.get(r.sipp) || 0) + 1);
  const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  return { sipp: top[0], locationCode: profile.locationCode };
}

export const pricingSuggestionEngine = { runPricingEngine, evaluateRule };
