/**
 * Positional utilization tiers (Fase 2.1) — PURE (no prisma/IO, unit-testable).
 *
 * As projected utilization rises, a tier moves the target price up the competitive
 * ladder. Each tier is `{ fromPct, type, n?, pct?, amount? }` and applies when
 * utilization ≥ fromPct (the HIGHEST such tier wins). Below the lowest fromPct, no
 * tier applies → the caller uses the base margin (cheapest − $X).
 *
 * Target types (all resolved against the per-vendor cheapest all-in prices for the cell):
 *   NTH_CHEAPEST   n     → the n-th cheapest competitor          (n=1 → cheapest)
 *   NTH_EXPENSIVE  n     → the n-th from the most expensive end
 *   MARKET               → the median of competitors
 *   MARKET_PCT     pct   → median × (1 + pct/100)   (e.g. +15% above market)
 *   CHEAPEST_MINUS amount→ cheapest − amount        (explicit margin as a tier)
 *
 * All targets are ALL-IN prices; the caller converts to a base rate via the gross-up.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Median of a numeric array (unsorted ok). null when empty. */
export function medianOf(arr) {
  const a = (Array.isArray(arr) ? arr : []).filter((x) => Number.isFinite(Number(x))).map(Number).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Pick the highest tier whose fromPct ≤ utilization%. null → use base margin. */
export function pickUtilizationTier(util, rules) {
  if (util == null || !Array.isArray(rules) || rules.length === 0) return null;
  const pct = util * 100;
  const sorted = [...rules].sort((a, b) => (Number(a.fromPct) || 0) - (Number(b.fromPct) || 0));
  let chosen = null;
  for (const t of sorted) { if (pct >= (Number(t.fromPct) || 0)) chosen = t; }
  return chosen;
}

/**
 * Resolve a tier to a target ALL-IN price using the cell's competitor prices.
 * `pricesAsc` is the per-vendor cheapest all-in prices (any order accepted).
 * Returns null when the tier/type/prices can't produce a number (caller falls back).
 */
export function resolveTierTarget(tier, pricesAsc) {
  if (!tier) return null;
  const asc = (Array.isArray(pricesAsc) ? pricesAsc : []).filter((x) => Number.isFinite(Number(x))).map(Number).sort((x, y) => x - y);
  const n = asc.length;
  if (n === 0) return null;
  const clampIdx = (i) => Math.min(Math.max(0, i), n - 1);
  const nth = Math.max(1, Number(tier.n) || 1);
  switch (String(tier.type || '').toUpperCase()) {
    case 'NTH_CHEAPEST': return round2(asc[clampIdx(nth - 1)]);
    case 'NTH_EXPENSIVE': return round2(asc[clampIdx(n - nth)]);
    case 'MARKET': return round2(medianOf(asc));
    case 'MARKET_PCT': return round2(medianOf(asc) * (1 + (Number(tier.pct) || 0) / 100));
    case 'CHEAPEST_MINUS': return round2(asc[0] - (Number(tier.amount) || 0));
    default: return null;
  }
}
