/**
 * Correction stage — writes the suggested BASE rental prices for a run.
 *
 * MECHANISM (2026-07-20 rework, Hector: "Engine A maintains the base").
 * Engine A's primary and only output is the BASE rate: `RateItem.daily` for each
 * managed class (and `Rate.daily` kept in sync when the rate is single-class — the
 * SJU rates all have header==item). Because `resolveForRental` reads the base for
 * EVERY date, maintaining the base keeps far-future dates and window-edge dates
 * current — the previous "per-date RateDailyPrice override across the scrape window"
 * mechanism left every date OUTSIDE the window frozen once Engine B retired.
 *
 * `computeRunComparison` emits one suggested base per (class, date). We collapse a
 * class to a single canonical base (the nearest in-window date — the most imminent,
 * booking-relevant signal). Genuine per-date variance is intentionally collapsed
 * into the base per Hector's call; if a future feature needs per-date variance it
 * can LAYER `RateDailyPrice` overrides ON TOP of the maintained base. To make the
 * base the single source of truth we CLEAR any future-dated overrides for a class
 * we write (bounded to rateId+vehicleTypeId+date>=today) so a stale override can't
 * mask the fresh base. The maxDeltaPct band is computed BASE-vs-BASE: current
 * `RateItem.daily` vs the suggested base.
 *
 * MONEY-SAFETY. Every write goes through the fail-closed guardrails in
 * market-autoapply-guardrails.js:
 *   - AUTO (cron): master kill switch (MARKET_AUTOAPPLY_ENABLED) AND per-profile
 *     autoApply AND full guardrails (floorBase + ceilingBase + maxDeltaPct). A move
 *     beyond maxDeltaPct is HELD, never applied. Below floor / above ceiling clamps.
 *   - MANUAL ("Apply now"): may bypass the per-profile enable and the maxDeltaPct
 *     band (warned), but floor + ceiling are HARD — required and clamped for humans
 *     too (a manual apply with no bounds configured HOLDs).
 *   - A class with no OWN RateItem is HELD in both modes (header-fallback data gap).
 * Every decision writes a PriceChangeLog row — the money trail of record.
 *
 * GO-LIVE ORDER (per managed rate): configure guardrails per location (floorBase +
 * ceilingBase + maxDeltaPct) → force-apply once to SEED the base (bounded by
 * floor/ceiling, bypassing only the delta band) → set the profile's autoApply=true
 * → flip MARKET_AUTOAPPLY_ENABLED. The one-time seed absorbs the ~grossed-down
 * regime change; steady-state AUTO then moves in small day-to-day deltas.
 *
 * Existing reservations are never re-priced: resolveForRental snapshots the quote
 * onto Reservation.dailyRate at booking and never re-reads Rate/RateItem/RateDailyPrice.
 */
import { prisma } from '../../lib/prisma.js';
import { cache } from '../../lib/cache.js';
import logger from '../../lib/logger.js';
import { computeRunComparison, getMarketPricingConfig } from './market-scrape-comparison.service.js';
import { evaluateWrite, guardrailsConfigured, isMarketAutoApplyEnabled } from './market-autoapply-guardrails.js';

function badRequest(msg) {
  const e = new Error(msg);
  e.httpStatus = 400;
  throw e;
}

function n2(v) { if (v == null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; }
function todayUTC() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; }
function toDateUTC(iso) { return new Date(`${String(iso).slice(0, 10)}T00:00:00.000Z`); }

/**
 * Build the money-trail "why" for a class decision: the vendor + cheapest that
 * anchored the cell, plus the actual target (tier / all-in / utilization). Stored
 * as a JSON string in PriceChangeLog.competitorBasis so the audit explains WHY a
 * price landed even when a utilization tier (median / Nth / market±%) drove it.
 */
function buildCompetitorBasis(row, taxAware) {
  const basis = {
    vendor: row.marketVendor ?? null,
    cheapest: row.marketCheapest ?? null,
    sampled: row.marketSampled ?? null,
  };
  if (taxAware) {
    basis.suggestedAllIn = row.suggestedAllIn ?? null;
    basis.utilization = row.utilization ?? null;
    basis.tier = row.tier ?? null; // null → base margin (cheapest − $X)
  }
  return JSON.stringify(basis);
}

/**
 * Apply a run's suggestions to the BASE rate under the money guardrails.
 *
 * @param {string} runId
 * @param {object} opts
 * @param {{tenantId?: string}} [opts.scope]
 * @param {boolean} [opts.force=false] - bypass the per-profile autoApply *enable*
 *   (manual "Apply now"). Does NOT bypass floor/ceiling; maxDeltaPct becomes a warning.
 * @param {'auto'|'manual'} [opts.mode] - defaults to 'manual' when force, else 'auto'.
 * @returns {Promise<{
 *   runId, profileId, targetRateId, mode,
 *   appliedCount, clampedCount, heldCount, heldPct,
 *   held: Array<{ sipp, vehicleTypeId, oldDaily, newDaily, deltaPct, reason }>,
 *   warnings, comparison
 * }>}
 */
export async function applyRunSuggestions(runId, opts = {}) {
  const { scope = {}, force = false } = opts;
  const mode = opts.mode || (force ? 'manual' : 'auto');
  if (!runId) badRequest('runId required');

  const comparison = await computeRunComparison(runId, { scope });

  const run = await prisma.marketScrapeRun.findFirst({ where: { id: runId }, include: { profile: true } });
  if (!run) badRequest('Run vanished between comparison and apply');
  const profile = run.profile;

  if (comparison.targetRateMissing) badRequest('Profile has no targetRateId — cannot apply suggestions');
  if (!profile.autoApply && !force) badRequest('Profile is not configured for auto-apply (pass force=true to override)');

  // Defense-in-depth: an AUTO apply is a no-op unless the master switch is on.
  if (mode === 'auto' && !force && !isMarketAutoApplyEnabled()) {
    await prisma.marketScrapeRun.update({ where: { id: runId }, data: { pricesApplied: 0, autoApplyAt: new Date() } });
    return emptyResult(runId, profile, mode, { masterOff: true, comparison });
  }

  const pricingConfig = await getMarketPricingConfig(profile.tenantId, profile.locationCode);
  const taxAware = !!comparison.taxAware;

  // Target rate base config: header daily + per-class RateItems (vt→daily) + single-class flag.
  const targetRate = await prisma.rate.findUnique({
    where: { id: profile.targetRateId },
    include: { rateItems: { select: { vehicleTypeId: true, daily: true } } },
  });
  const rateItems = targetRate?.rateItems || [];
  const singleItem = rateItems.length === 1;
  const headerDaily = n2(targetRate?.daily);
  const rateItemDailyByVt = new Map();
  for (const it of rateItems) rateItemDailyByVt.set(it.vehicleTypeId, n2(it.daily));

  // Group candidate rows by class (vehicleTypeId). A class collapses to a single
  // canonical base = the nearest in-window date's suggested base.
  const byClass = new Map(); // vehicleTypeId -> { sipp, rows: [...] }
  for (const r of comparison.rows) {
    if (r.vehicleTypeId == null) continue;
    if (r.suggestedPrice == null || !Number.isFinite(Number(r.suggestedPrice)) || Number(r.suggestedPrice) <= 0) continue;
    let g = byClass.get(r.vehicleTypeId);
    if (!g) { g = { sipp: r.sipp, rows: [] }; byClass.set(r.vehicleTypeId, g); }
    g.rows.push(r);
  }

  const today = todayUTC();
  const auditRows = [];
  const held = [];
  const warnings = [];
  const baseWrites = []; // { vehicleTypeId, finalDaily }
  let appliedCount = 0;
  let clampedCount = 0;

  for (const [vehicleTypeId, group] of byClass) {
    const rowsAsc = [...group.rows].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const anchor = rowsAsc[0]; // nearest in-window date drives the canonical base
    const canonicalBase = n2(anchor.suggestedPrice);
    const hasOwnRateItem = rateItemDailyByVt.has(vehicleTypeId);
    const currentBase = rateItemDailyByVt.get(vehicleTypeId) ?? null;
    const currentFromFallback = !hasOwnRateItem;

    const decision = evaluateWrite({
      suggestedBase: canonicalBase,
      currentBase,
      config: pricingConfig,
      hasOwnRateItem,
      currentFromFallback,
      mode,
    });

    const competitorBasis = buildCompetitorBasis(anchor, taxAware);
    const auditBase = {
      tenantId: profile.tenantId,
      locationCode: profile.locationCode,
      rateId: profile.targetRateId,
      vehicleTypeId,
      date: toDateUTC(anchor.date),
      // For a fallback class (no own RateItem) record the header base customers get today.
      oldDaily: currentBase != null ? currentBase : headerDaily,
      runId,
      competitorBasis,
      engine: mode === 'manual' ? 'manual' : 'MARKET_A',
      oldFromFallback: currentFromFallback,
    };
    for (const w of decision.warnings) warnings.push({ sipp: group.sipp, message: w });

    if (decision.outcome === 'held') {
      held.push({ sipp: group.sipp, vehicleTypeId, oldDaily: currentBase, newDaily: canonicalBase, deltaPct: decision.deltaPct, reason: decision.reason });
      auditRows.push({ ...auditBase, newDaily: n2(canonicalBase), deltaPct: decision.deltaPct, outcome: 'held', reason: decision.reason });
      continue;
    }

    // No-op guard: base unchanged within 1¢ → don't rewrite the base, but still clear
    // any stale future overrides so the (equal) base governs uniformly.
    const noop = currentBase != null && Math.abs(decision.finalDaily - currentBase) < 0.01;
    if (!noop) {
      if (decision.outcome === 'clamped') clampedCount += 1; else appliedCount += 1;
      auditRows.push({ ...auditBase, newDaily: decision.finalDaily, deltaPct: decision.deltaPct, outcome: decision.outcome, reason: decision.reason || decision.warnings.join('; ') || null });
    }
    baseWrites.push({ vehicleTypeId, finalDaily: decision.finalDaily });
  }

  // Persist the audit trail first (money trail of record), then the base writes.
  if (auditRows.length) {
    try { await prisma.priceChangeLog.createMany({ data: auditRows }); }
    catch (e) { logger.warn('[market-autoapply] failed to write PriceChangeLog', { runId, error: e.message }); }
  }

  // Write the base(s) + clear future overrides so the base is the single source of
  // truth, all in ONE transaction per class.
  for (const w of baseWrites) {
    const ops = [
      prisma.rateItem.updateMany({ where: { rateId: profile.targetRateId, vehicleTypeId: w.vehicleTypeId }, data: { daily: w.finalDaily } }),
      // Clear future-dated ENGINE-AUTHORED overrides only (source:'MARKET_A') so a
      // stale engine override can't mask the freshly-maintained base. Operator-set
      // overrides (source null / anything ≠ 'MARKET_A' — holiday/event surges) are
      // NEVER touched and continue to win over the base for their date. NOTE: the
      // steady-state engine writes base-only, so today this clears NOTHING (no
      // engine-authored override exists); any future layered-override path MUST
      // stamp source:'MARKET_A' to stay self-cleaning.
      prisma.rateDailyPrice.deleteMany({ where: { rateId: profile.targetRateId, vehicleTypeId: w.vehicleTypeId, date: { gte: today }, source: 'MARKET_A' } }),
    ];
    // Keep the header in sync only for single-class rates (SJU convention header==item);
    // multi-class headers aren't the quote source (resolveForRental uses item.daily).
    if (singleItem) ops.push(prisma.rate.update({ where: { id: profile.targetRateId }, data: { daily: w.finalDaily } }));
    await prisma.$transaction(ops);
  }

  if (baseWrites.length) {
    // The booking-engine caches quotes for ~5 min; invalidate so new base flows through.
    // Existing reservations are unaffected (snapshotted at booking). Same pattern as
    // the PricingRule engine's AUTO_APPLY.
    cache.invalidate(`t:${profile.tenantId}:booking:`);
    cache.invalidate(`t:${profile.tenantId}:public:`);
  }

  const writtenCount = appliedCount + clampedCount;
  const decidedCount = writtenCount + held.length;
  const heldPct = decidedCount > 0 ? Number(((held.length / decidedCount) * 100).toFixed(1)) : 0;

  await prisma.marketScrapeRun.update({
    where: { id: runId },
    data: { pricesApplied: writtenCount, ...(mode === 'auto' ? { autoApplyAt: new Date() } : {}) },
  });

  if (held.length) {
    logger.warn('[market-autoapply] held classes (not written)', {
      runId, profileId: profile.id, mode, heldCount: held.length, heldPct,
      reasons: [...new Set(held.map((h) => h.reason))],
    });
  }

  return {
    runId,
    profileId: profile.id,
    targetRateId: profile.targetRateId,
    mode,
    appliedCount,
    clampedCount,
    heldCount: held.length,
    heldPct,
    held,
    warnings,
    comparison,
  };
}

function emptyResult(runId, profile, mode, extra = {}) {
  return {
    runId,
    profileId: profile.id,
    targetRateId: profile.targetRateId,
    mode,
    appliedCount: 0,
    clampedCount: 0,
    heldCount: 0,
    heldPct: 0,
    held: [],
    warnings: [],
    ...extra,
  };
}

/**
 * Cron orchestrator for ONE profile. Both gates must pass to write:
 *   - MARKET_AUTOAPPLY_ENABLED (master kill switch), AND
 *   - profile.autoApply (per-profile enable).
 * Applies the given run, or the profile's latest successful run. When auto-selecting
 * the latest run, it SHORT-CIRCUITS if that run was already auto-applied (autoApplyAt
 * set) so the 15-min trigger doesn't re-compute + re-log an unchanged run. Never
 * throws for a disabled/skip state — the scrape runner treats this best-effort.
 */
export async function runAutoApplyForProfile(profileId, opts = {}) {
  const { scope = {} } = opts;
  if (!isMarketAutoApplyEnabled()) return { skipped: true, reason: 'master_switch_off', profileId };

  const where = { id: profileId };
  if (scope.tenantId) where.tenantId = scope.tenantId;
  const profile = await prisma.marketScrapeProfile.findFirst({ where });
  if (!profile) return { skipped: true, reason: 'profile_not_found', profileId };
  if (!profile.autoApply) return { skipped: true, reason: 'profile_autoapply_off', profileId };
  if (!profile.targetRateId) return { skipped: true, reason: 'no_target_rate', profileId };

  let runId = opts.runId;
  if (!runId) {
    const latest = await prisma.marketScrapeRun.findFirst({
      where: { profileId: profile.id, status: { in: ['SUCCESS', 'PARTIAL'] } },
      orderBy: { finishedAt: 'desc' },
      select: { id: true, autoApplyAt: true },
    });
    if (!latest) return { skipped: true, reason: 'no_successful_run', profileId };
    if (latest.autoApplyAt) return { skipped: true, reason: 'already_applied', profileId, runId: latest.id };
    runId = latest.id;
  }

  return applyRunSuggestions(runId, { scope, force: false, mode: 'auto' });
}

/**
 * Cron orchestrator across ALL auto-apply-enabled profiles (optionally tenant-scoped).
 * Used by the post-scrape internal trigger. Dark when the master switch is off.
 * Errors on one profile don't stop the others.
 */
export async function runMarketAutoApplyAll(opts = {}) {
  const { tenantId = null } = opts;
  const out = { masterEnabled: isMarketAutoApplyEnabled(), profilesRun: 0, applied: 0, held: 0, clamped: 0, results: [], errors: [] };
  if (!out.masterEnabled) return out;

  const where = { autoApply: true, active: true, targetRateId: { not: null } };
  if (tenantId) where.tenantId = tenantId;
  const profiles = await prisma.marketScrapeProfile.findMany({ where, select: { id: true, tenantId: true } });

  for (const p of profiles) {
    try {
      const res = await runAutoApplyForProfile(p.id, { scope: { tenantId: p.tenantId } });
      out.profilesRun += 1;
      if (!res.skipped) {
        out.applied += res.appliedCount || 0;
        out.held += res.heldCount || 0;
        out.clamped += res.clampedCount || 0;
      }
      out.results.push({ profileId: p.id, ...(res.skipped ? { skipped: res.reason } : { applied: res.appliedCount, held: res.heldCount, clamped: res.clampedCount, heldPct: res.heldPct }) });
    } catch (e) {
      out.errors.push({ profileId: p.id, message: e.message });
    }
  }
  return out;
}

/**
 * Set of Rate ids Engine A (Market Intelligence auto-apply) OWNS and is ACTUALLY
 * able to write — so Engine B (PricingRule) retires from them (one engine per rate,
 * enforced on BOTH the cron and the manual suggestion-apply route). A rate qualifies
 * only when: the master switch is ON (a DARK deploy leaves Engine B untouched — no
 * orphan), AND an active autoApply profile targets it, AND that profile's location
 * has FULLY-configured guardrails (else Engine A would HOLD everything and retiring B
 * would FREEZE the rate). Never throws — on error returns an empty set (fail-safe:
 * Engine B keeps its current behavior).
 */
export async function getEngineAManagedRateIds(opts = {}) {
  const { tenantId = null } = opts;
  try {
    if (!isMarketAutoApplyEnabled()) return new Set();
    const where = { autoApply: true, active: true, targetRateId: { not: null } };
    if (tenantId) where.tenantId = tenantId;
    const profiles = await prisma.marketScrapeProfile.findMany({
      where, select: { targetRateId: true, tenantId: true, locationCode: true },
    });
    const out = new Set();
    for (const p of profiles) {
      const cfg = await getMarketPricingConfig(p.tenantId, p.locationCode);
      if (guardrailsConfigured(cfg).ok) out.add(p.targetRateId);
    }
    return out;
  } catch {
    return new Set();
  }
}

export const marketScrapeCorrectionService = {
  applyRunSuggestions,
  runAutoApplyForProfile,
  runMarketAutoApplyAll,
  getEngineAManagedRateIds,
};
