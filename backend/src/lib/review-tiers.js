/**
 * Review-tier commission math (LAX #5, 2026-07-25). MONEY. Pure.
 *
 * Hector's table: the counter employee's percent over what they sell is set
 * by how many VALIDATED customer reviews they collected in the month:
 *   0-9 → 0% · 10-19 → 2% · 20-29 → 3% · 30-39 → 4% · 40-60 → 5% · 61+ → 6%
 * (stored per plan as reviewTiersJson so the scale is editable without code).
 *
 * A tier list is [{ minReviews, pct }]. tierPercentFor picks the highest
 * tier whose minReviews <= count; below the lowest tier the percent is 0 —
 * "no reviews, no commission" is the ground state, never an error.
 */

export function normalizeReviewTiers(raw) {
  const list = Array.isArray(raw) ? raw : null;
  if (!list || !list.length) return null;
  const tiers = [];
  for (const t of list) {
    const minReviews = Number(t?.minReviews);
    const pct = Number(t?.pct);
    if (!Number.isInteger(minReviews) || minReviews < 0) return null;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
    tiers.push({ minReviews, pct });
  }
  tiers.sort((a, b) => a.minReviews - b.minReviews);
  // Duplicate thresholds are a config bug (which pct wins?) — reject loud-ly
  // at the caller (null = tiers not usable → legacy catalog behavior).
  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i].minReviews === tiers[i - 1].minReviews) return null;
  }
  return tiers;
}

export function tierPercentFor(validatedCount, tiers) {
  const normalized = normalizeReviewTiers(tiers);
  if (!normalized) return 0;
  const count = Number(validatedCount);
  if (!Number.isFinite(count) || count < 0) return 0;
  let pct = 0;
  for (const tier of normalized) {
    if (count >= tier.minReviews) pct = tier.pct;
    else break;
  }
  return pct;
}

/** Hector's table, the default scale seeded into a new plan's tiers UI. */
export const DEFAULT_REVIEW_TIERS = [
  { minReviews: 10, pct: 2 },
  { minReviews: 20, pct: 3 },
  { minReviews: 30, pct: 4 },
  { minReviews: 40, pct: 5 },
  { minReviews: 61, pct: 6 }
];
