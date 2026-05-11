/**
 * MarketScrapeProfile runner — executes a profile end-to-end:
 *
 *   1. Load the profile (tenant-scoped) + validate it's runnable
 *   2. Insert a MarketScrapeRun row with status=RUNNING
 *   3. For each pickup date in [today+windowStartDay .. today+windowEndDay]:
 *        - call scraper.scrapeOneSearch(...)
 *        - map listings to MarketObservation rows (one row per listing/SIPP)
 *        - batch-insert via createMany
 *        - random delay before the next request (anti-detection)
 *   4. Update the run row with status + counts + first-error (if any)
 *   5. Update the profile's lastRunAt / lastSuccessAt / lastRunStatus
 *
 * The scraper is INJECTED rather than constructed in-place. Production wires
 * createExpediaSession() from expedia-scraper.js; tests pass a fake that
 * returns fixture listings without touching Playwright or the network.
 *
 * Comparison + Correction (B.4) are NOT implemented here — this stage stops
 * at "observations are in the DB". The Correction step will be a separate
 * service that diffs MarketObservation against RateDailyPrice and POSTs to
 * /api/rates/:id/daily-prices/import when profile.autoApply === true.
 */
import { prisma } from '../../lib/prisma.js';

function badRequest(msg) {
  const e = new Error(msg);
  e.httpStatus = 400;
  throw e;
}

function notFound(msg) {
  const e = new Error(msg);
  e.httpStatus = 404;
  throw e;
}

/**
 * Translate an Expedia listing + the profile's run context into a
 * MarketObservation row. Unmapped SIPPs are kept (with status=UNMAPPED and
 * sipp='UNMAPPED') so we can extend the SIPP map after the fact rather than
 * losing the data.
 */
function listingToObservation({ listing, runId, profileId, pickup, ret, lorDays, sipp }) {
  const effectiveDaily = listing.totalPrice != null && lorDays > 0
    ? Number((listing.totalPrice / lorDays).toFixed(2))
    : null;
  return {
    runId,
    profileId,
    pickupDate: pickup,
    returnDate: ret,
    lorDays,
    sipp: sipp || 'UNMAPPED',
    rawCategory: listing.category || null,
    vendor: listing.vendor || null,
    source: 'EXPEDIA',
    dailyPrice: listing.dailyPrice != null ? listing.dailyPrice : null,
    totalPrice: listing.totalPrice != null ? listing.totalPrice : null,
    effectiveDailyPrice: effectiveDaily,
    currency: 'USD',
    status: sipp ? 'FOUND' : 'UNMAPPED'
  };
}

/**
 * Compute the final run status from per-request counters:
 *   - all ok, none err              -> SUCCESS
 *   - some ok, some err             -> PARTIAL
 *   - all err (or no requests made) -> FAILED
 */
function computeRunStatus(ok, err) {
  if (ok > 0 && err === 0) return 'SUCCESS';
  if (ok > 0 && err > 0) return 'PARTIAL';
  return 'FAILED';
}

/**
 * @param {string} profileId
 * @param {object} opts
 * @param {{tenantId?: string}} [opts.scope] - tenant scope. When omitted,
 *   intended for system runs from cron; tenantId is read from the profile.
 * @param {object} opts.scraper - { scrapeOneSearch, wait?, close? }
 * @param {{exact, keyword_fallback}} opts.sippMap
 * @param {Date} [opts.now] - "today" used to compute the pickup window
 *   (defaults to new Date()). Tests pin this to a fixed instant.
 * @param {(category, sippMap) => string|null} [opts.categoryToSipp] -
 *   injectable so tests don't have to load the real SIPP JSON.
 * @param {number} [opts.delayMinMs=5000]
 * @param {number} [opts.delayMaxMs=15000]
 * @returns {Promise<{runId, status, durationSec, requestsOk, requestsErr,
 *   observationsCount, errorMessage}>}
 */
export async function runProfile(profileId, opts = {}) {
  const {
    scope = {},
    scraper,
    sippMap,
    now = new Date(),
    delayMinMs = 5000,
    delayMaxMs = 15000
  } = opts;

  // SIPP mapper is injectable — defaults to the real one. Resolved here so we
  // don't import expedia-scraper.js at module load (lazy-load saves test cost).
  let mapFn = opts.categoryToSipp;
  if (!mapFn) {
    const mod = await import('./expedia-scraper.js');
    mapFn = mod.categoryToSipp;
  }

  if (!profileId) badRequest('profileId required');
  if (!scraper || typeof scraper.scrapeOneSearch !== 'function') {
    badRequest('scraper.scrapeOneSearch is required');
  }
  if (!sippMap || !sippMap.exact) badRequest('sippMap is required');

  // Load + validate the profile. tenantId scope is enforced when present;
  // cron-driven runs pass no scope and trust the cron's per-profile selection.
  const where = { id: profileId };
  if (scope.tenantId) where.tenantId = scope.tenantId;
  const profile = await prisma.marketScrapeProfile.findFirst({ where });
  if (!profile) notFound('Profile not found');
  if (!profile.active) badRequest('Profile is inactive');
  const sources = Array.isArray(profile.sources) ? profile.sources : [];
  if (!sources.includes('EXPEDIA')) {
    badRequest('Profile sources must include EXPEDIA (only source supported in B.3)');
  }

  // Pin "today" at UTC midnight so the window math is deterministic.
  const today = new Date(now.getTime());
  today.setUTCHours(0, 0, 0, 0);

  // Create the run record up front so a crashed worker still leaves a trail.
  const run = await prisma.marketScrapeRun.create({
    data: { profileId: profile.id, status: 'RUNNING', startedAt: new Date() }
  });

  const startMs = Date.now();
  let requestsOk = 0;
  let requestsErr = 0;
  let observationsCount = 0;
  let firstError = null;

  const totalDays = profile.windowEndDay - profile.windowStartDay + 1;

  try {
    for (let i = 0; i < totalDays; i += 1) {
      const dayOff = profile.windowStartDay + i;
      const pickup = new Date(today.getTime());
      pickup.setUTCDate(pickup.getUTCDate() + dayOff);
      const ret = new Date(pickup.getTime());
      ret.setUTCDate(ret.getUTCDate() + profile.lorDays);

      let result;
      try {
        result = await scraper.scrapeOneSearch({
          airport: profile.locationCode,
          pickupDate: pickup,
          returnDate: ret
        });
      } catch (err) {
        // Treat a thrown scraper error like a returned-error result so the
        // loop keeps going for the remaining days.
        result = { error: `scraper-threw: ${err.message}` };
      }

      if (result.error) {
        requestsErr += 1;
        if (!firstError) firstError = String(result.error);
      } else {
        requestsOk += 1;
        const observations = [];
        for (const listing of result.listings || []) {
          const sipp = mapFn(listing.category, sippMap);
          if (listing.dailyPrice == null && listing.totalPrice == null) {
            // No price at all — skip; not useful for Comparison.
            continue;
          }
          observations.push(listingToObservation({
            listing,
            runId: run.id,
            profileId: profile.id,
            pickup,
            ret,
            lorDays: profile.lorDays,
            sipp
          }));
        }
        if (observations.length > 0) {
          await prisma.marketObservation.createMany({ data: observations });
          observationsCount += observations.length;
        }
      }

      // Random inter-request delay (anti-detection). Skip on last iteration
      // so we don't pad the total run time pointlessly.
      if (i < totalDays - 1 && typeof scraper.wait === 'function') {
        const delay = delayMinMs + Math.floor(Math.random() * Math.max(0, delayMaxMs - delayMinMs));
        await scraper.wait(delay);
      }
    }
  } finally {
    // Always release the browser handle, even on a thrown loop error.
    if (typeof scraper.close === 'function') {
      try { await scraper.close(); } catch (_) { /* swallow on close */ }
    }
  }

  const status = computeRunStatus(requestsOk, requestsErr);
  const finishedAt = new Date();
  const durationSec = Math.round((Date.now() - startMs) / 1000);

  await prisma.marketScrapeRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt,
      durationSec,
      requestsOk,
      requestsErr,
      observationsCount,
      errorMessage: firstError || null
    }
  });

  // Update the profile's last-run tracking so the Activity Queue UI can
  // surface freshness/health without joining to runs.
  const profileUpdate = {
    lastRunAt: finishedAt,
    lastRunStatus: status,
    lastRunError: firstError || null
  };
  if (status === 'SUCCESS' || status === 'PARTIAL') {
    profileUpdate.lastSuccessAt = finishedAt;
  }
  await prisma.marketScrapeProfile.update({
    where: { id: profile.id },
    data: profileUpdate
  });

  return {
    runId: run.id,
    status,
    durationSec,
    requestsOk,
    requestsErr,
    observationsCount,
    errorMessage: firstError
  };
}

export const marketScrapeRunnerService = { runProfile };
