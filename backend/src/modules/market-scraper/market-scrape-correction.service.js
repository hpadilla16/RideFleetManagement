/**
 * Correction stage — writes the suggested prices to RateDailyPrice via the
 * SAME path the Excel suggestion-report import uses (ratesService.import-
 * DailyPrices). Reusing that path means:
 *
 *   - identical batching / transaction semantics (80 upserts per tx)
 *   - identical SIPP -> VehicleType validation
 *   - identical `Rate.sameSpecialRates = true` flag flip that tells the
 *     booking engine to read overrides
 *   - identical audit shape (added/updated/unchanged/skipped/errors)
 *
 * This service only runs when `profile.autoApply === true`. Callers (the
 * scheduler, the "Apply" button on the comparison UI) gate on that flag.
 * Research-only profiles produce comparisons for review and stop there.
 *
 * The MarketScrapeRun row is updated with `pricesApplied` so the Activity
 * Queue UI can show "12 of 15 cells written".
 */
import { prisma } from '../../lib/prisma.js';
import { ratesService } from '../rates/rates.service.js';
import { computeRunComparison } from './market-scrape-comparison.service.js';

function badRequest(msg) {
  const e = new Error(msg);
  e.httpStatus = 400;
  throw e;
}

/**
 * Apply a run's suggestions to RateDailyPrice when the profile is set up for
 * auto-apply.
 *
 * @param {string} runId
 * @param {object} opts
 * @param {{tenantId?: string}} [opts.scope]
 * @param {boolean} [opts.force=false] - bypass the profile.autoApply gate
 *   (used by the manual "Apply now" button from the comparison UI; the cron
 *   path never sets this).
 * @returns {Promise<{
 *   runId, profileId, targetRateId,
 *   appliedCount, addedCount, updatedCount,
 *   unchangedCount, skippedCount, errorCount,
 *   comparison        // same shape as computeRunComparison()
 * }>}
 */
export async function applyRunSuggestions(runId, opts = {}) {
  const { scope = {}, force = false } = opts;
  if (!runId) badRequest('runId required');

  const comparison = await computeRunComparison(runId, { scope });

  // Re-fetch the profile to enforce the autoApply gate (computeRunComparison
  // already enforced tenant scope via the run lookup).
  const run = await prisma.marketScrapeRun.findFirst({
    where: { id: runId },
    include: { profile: true }
  });
  // computeRunComparison would have thrown 404 already if run was missing;
  // belt-and-suspenders here just to be defensive against direct callers.
  if (!run) badRequest('Run vanished between comparison and apply');
  const profile = run.profile;

  if (comparison.targetRateMissing) {
    badRequest('Profile has no targetRateId — cannot apply suggestions');
  }
  if (!profile.autoApply && !force) {
    badRequest('Profile is not configured for auto-apply (pass force=true to override)');
  }

  // Build the row payload importDailyPrices expects. The shape mirrors the
  // suggestion-report Excel contract (Sipp / PickUpDate / SuggestedAmount).
  const writable = comparison.rows.filter((r) =>
    r.willUpdate
    && r.vehicleTypeId != null
    && r.suggestedPrice != null
    && Number.isFinite(Number(r.suggestedPrice))
    && Number(r.suggestedPrice) > 0
  );

  if (writable.length === 0) {
    // Still update the run's pricesApplied counter to 0 so the Activity Queue
    // shows "0 cells written" instead of "(empty)".
    await prisma.marketScrapeRun.update({
      where: { id: runId },
      data: { pricesApplied: 0 }
    });
    return {
      runId,
      profileId: profile.id,
      targetRateId: profile.targetRateId,
      appliedCount: 0,
      addedCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      comparison
    };
  }

  const rows = writable.map((r) => ({
    Sipp: r.sipp,
    PickUpDate: r.date,                 // 'YYYY-MM-DD' — accepted by parseDynamicPriceDate
    SuggestedAmount: r.suggestedPrice
  }));

  const importReport = await ratesService.importDailyPrices(
    profile.targetRateId,
    rows,
    // Pass the profile's tenant context — even cron-triggered runs need
    // tenant-scoped writes so cross-tenant rate IDs can't sneak through.
    { tenantId: profile.tenantId, ...(scope || {}) },
    { silentSkipUnknownTypes: true }
  );

  await prisma.marketScrapeRun.update({
    where: { id: runId },
    data: { pricesApplied: importReport.imported || 0 }
  });

  return {
    runId,
    profileId: profile.id,
    targetRateId: profile.targetRateId,
    appliedCount: importReport.imported || 0,
    addedCount: importReport.addedCount || 0,
    updatedCount: importReport.updatedCount || 0,
    unchangedCount: importReport.unchangedCount || 0,
    skippedCount: importReport.skippedCount || 0,
    errorCount: importReport.errorCount || 0,
    comparison
  };
}

export const marketScrapeCorrectionService = { applyRunSuggestions };
