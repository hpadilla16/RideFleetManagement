/**
 * Where a scrape's suggestions land, per brand (2026-09-09).
 *
 * Hector: "los precios que son de MEX, escriban a MEX directamente y que los de
 * zezgo escriban al de zezgo cuando prendemos el rate writeback".
 *
 * ── WHY FAN OUT INSTEAD OF CLONING THE PROFILE ──────────────────────────────
 * A profile is a SCRAPE: a real browser, Scrapfly credits, minutes per run. The
 * market at one airport is identical for every brand selling there — Ace is
 * $15.67 whether we ask on Economy's behalf or Zezgo's. Cloning the profile per
 * franchise would pay that cost three times to read the same page, and then the
 * three copies would drift apart on window, cadence and sources.
 *
 * So one scrape, several targets. Each target names the Rate it writes and may
 * override the strategy: Economy can undercut by a dollar while Zezgo matches,
 * off a single run.
 *
 * ── THE BACK-COMPATIBILITY GUARANTEE ────────────────────────────────────────
 * A profile with no target rows resolves to exactly ONE target — its own
 * `targetRateId` and its own strategy. That is every profile in the system
 * today, and it means the caller can be rewritten to loop over targets without
 * changing what any existing profile does. The synthesized target is marked
 * `legacy: true` so a caller can tell the difference when it matters.
 *
 * Pairs with `integrations/booking-source/rate-franchise.js`, which is the
 * other half of the loop: this decides which Rate a brand's prices are written
 * TO, that decides which Rate a brand's writeback reads FROM.
 */

import { prisma as defaultPrisma } from '../../lib/prisma.js';

/**
 * The strategy a target actually runs.
 *
 * PURE. A target overrides the profile only where it says something: a row that
 * sets `strategy` but leaves `strategyAmount` null is taking the profile's
 * amount deliberately, not resetting it to zero — reading it as zero would turn
 * "cheapest minus a dollar" into "match the cheapest" without anybody asking.
 */
export function effectiveStrategy(profile, target) {
  const p = profile || {};
  const t = target || {};
  const pick = (key) => (t[key] === null || t[key] === undefined ? p[key] : t[key]);
  return {
    strategy: t.strategy || p.strategy,
    strategyAmount: pick('strategyAmount'),
    strategyPct: pick('strategyPct'),
    strategyFloor: pick('strategyFloor'),
  };
}

/**
 * Every place this profile's suggestions should be written.
 *
 * @param {object} profile  needs id, targetRateId, strategy*, autoApply
 * @param {object} [deps]   { prisma }
 * @returns {Promise<Array>} [{ id, franchiseId, rateId, autoApply, legacy, ...strategy }]
 */
export async function resolveProfileTargets(profile, deps = {}) {
  const db = deps.prisma || defaultPrisma;
  if (!profile?.id) return [];

  const rows = typeof db?.marketScrapeProfileTarget?.findMany === 'function'
    ? await db.marketScrapeProfileTarget.findMany({
      where: { profileId: profile.id, active: true },
      select: {
        id: true, franchiseId: true, rateId: true, autoApply: true,
        strategy: true, strategyAmount: true, strategyPct: true, strategyFloor: true,
      },
    }).catch(() => [])
    : [];

  if (Array.isArray(rows) && rows.length) {
    // A target with no rate writes nowhere; dropping it here keeps every caller
    // from having to check.
    return rows.filter((r) => r.rateId).map((r) => ({
      id: r.id,
      franchiseId: r.franchiseId ?? null,
      rateId: r.rateId,
      autoApply: Boolean(r.autoApply),
      legacy: false,
      ...effectiveStrategy(profile, r),
    }));
  }

  // No rows: the profile itself is the single, house-wide target. This is the
  // shape every profile has today.
  if (!profile.targetRateId) return [];
  return [{
    id: null,
    franchiseId: null,
    rateId: profile.targetRateId,
    autoApply: Boolean(profile.autoApply),
    legacy: true,
    ...effectiveStrategy(profile, null),
  }];
}

/**
 * Refuse a duplicate target — same profile, same brand, SAME RATE.
 *
 * The key is the triple, not (profile, franchise). A brand needs one target per
 * Rate: LAX keeps a separate single-class Rate per class, so a brand covering
 * seven classes has seven rows and refusing the second would have let it price
 * exactly one class.
 *
 * It is still checked here rather than left to the index, because Postgres
 * treats NULLs as DISTINCT: a house target has a null franchise, so the unique
 * index would happily accept the same (profile, null, rate) twice.
 */
export async function assertTargetIsUnique(profileId, franchiseId, rateId, deps = {}) {
  const db = deps.prisma || defaultPrisma;
  if (!profileId || !rateId) return;
  const where = { profileId, franchiseId: franchiseId ?? null, rateId };
  const clash = typeof db?.marketScrapeProfileTarget?.findFirst === 'function'
    ? await db.marketScrapeProfileTarget.findFirst({ where, select: { id: true } })
    : null;
  if (clash && clash.id !== deps.ignoreId) {
    const e = new Error(
      franchiseId
        ? 'That brand already writes to this rate from this profile'
        : 'The house target already writes to this rate from this profile',
    );
    e.httpStatus = 409;
    throw e;
  }
}

/**
 * Which targets an automatic run may write.
 *
 * Auto-apply is per target on purpose: one brand can be trusted to write while
 * another is still being watched, and the profile-level flag alone could not
 * express that. A legacy target keeps answering to the profile's own flag.
 */
export function autoApplyTargets(targets) {
  return (Array.isArray(targets) ? targets : []).filter((t) => t?.autoApply && t?.rateId);
}
