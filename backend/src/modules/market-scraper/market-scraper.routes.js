import { Router } from 'express';
import { marketScrapeProfileService } from './market-scrape-profile.service.js';
import { computeRunComparison, buildRunComparisonWorkbook } from './market-scrape-comparison.service.js';
import { applyRunSuggestions } from './market-scrape-correction.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { runSelfCheck } from './price-self-check.service.js';
import {
  listProfileTargets, createProfileTarget, updateProfileTarget, deleteProfileTarget,
} from './profile-targets.crud.js';

/**
 * Routes for the Market Intelligence pipeline:
 *   GET    /api/market-scraper/profiles
 *   POST   /api/market-scraper/profiles
 *   GET    /api/market-scraper/profiles/:id
 *   PATCH  /api/market-scraper/profiles/:id
 *   DELETE /api/market-scraper/profiles/:id
 *
 *   GET    /api/market-scraper/profiles/:id/runs
 *   GET    /api/market-scraper/runs/:runId
 *   GET    /api/market-scraper/runs/:runId/cheapest      (per-(date,sipp) cheapest)
 *   GET    /api/market-scraper/runs/:runId/comparison    (diff vs current RateDailyPrice — B.4)
 *   POST   /api/market-scraper/runs/:runId/apply         (write suggestions to RateDailyPrice — B.4)
 *
 *   GET    /api/market-scraper/profiles/:id/observations
 *
 *   GET    /api/market-scraper/profiles/:id/targets      per-brand write targets
 *   POST   /api/market-scraper/profiles/:id/targets
 *   PATCH  /api/market-scraper/targets/:targetId
 *   DELETE /api/market-scraper/targets/:targetId
 *
 *   GET    /api/market-scraper/self-check?locationCode=&days=
 *          Are we publishing what the strategy said? Two axes per cell: vs the
 *          TARGET (leaving money / priced out) and vs the CHEAPEST COMPETITOR
 *          (undercut). Read-only — it reports, it never writes a price.
 *
 * All routes are tenant-scoped via scopeFor(req). Auth + role middleware is
 * mounted in main.js. Errors thrown by the service with `httpStatus` get
 * translated to that status; otherwise propagated to the global error handler.
 */

export const marketScraperRouter = Router();

function handle(err, res, next) {
  if (err?.httpStatus) {
    return res.status(err.httpStatus).json({ error: err.message });
  }
  return next(err);
}

// ----- Profile CRUD -------------------------------------------------------

marketScraperRouter.get('/profiles', async (req, res, next) => {
  try {
    res.json(await marketScrapeProfileService.list(scopeFor(req)));
  } catch (e) { handle(e, res, next); }
});

marketScraperRouter.post('/profiles', async (req, res, next) => {
  try {
    const out = await marketScrapeProfileService.create(req.body || {}, scopeFor(req));
    res.status(201).json(out);
  } catch (e) {
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: 'A profile with that name already exists for this tenant' });
    }
    handle(e, res, next);
  }
});

marketScraperRouter.get('/profiles/:id', async (req, res, next) => {
  try {
    const out = await marketScrapeProfileService.getById(req.params.id, scopeFor(req));
    if (!out) return res.status(404).json({ error: 'Profile not found' });
    res.json(out);
  } catch (e) { handle(e, res, next); }
});

marketScraperRouter.patch('/profiles/:id', async (req, res, next) => {
  try {
    const out = await marketScrapeProfileService.update(req.params.id, req.body || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: 'A profile with that name already exists for this tenant' });
    }
    handle(e, res, next);
  }
});

marketScraperRouter.delete('/profiles/:id', async (req, res, next) => {
  try {
    await marketScrapeProfileService.remove(req.params.id, scopeFor(req));
    res.status(204).send();
  } catch (e) { handle(e, res, next); }
});

// ----- Runs ---------------------------------------------------------------

marketScraperRouter.get('/profiles/:id/runs', async (req, res, next) => {
  try {
    const limit = req.query?.limit ? Number(req.query.limit) : 50;
    res.json(await marketScrapeProfileService.listRuns(req.params.id, scopeFor(req), { limit }));
  } catch (e) { handle(e, res, next); }
});

marketScraperRouter.get('/runs/:runId', async (req, res, next) => {
  try {
    const out = await marketScrapeProfileService.getRun(req.params.runId, scopeFor(req));
    if (!out) return res.status(404).json({ error: 'Run not found' });
    res.json(out);
  } catch (e) { handle(e, res, next); }
});

marketScraperRouter.get('/runs/:runId/cheapest', async (req, res, next) => {
  try {
    const out = await marketScrapeProfileService.getRunCheapestPerSipp(req.params.runId, scopeFor(req));
    res.json(out);
  } catch (e) { handle(e, res, next); }
});

// ----- Comparison (B.4 — diff vs current RateDailyPrice) ------------------

marketScraperRouter.get('/runs/:runId/comparison', async (req, res, next) => {
  try {
    const out = await computeRunComparison(req.params.runId, { scope: scopeFor(req) });
    res.json(out);
  } catch (e) { handle(e, res, next); }
});

// RateHighway-style Excel: prices + suggested by vehicle class (SIPP) and by day.
marketScraperRouter.get('/runs/:runId/export.xlsx', async (req, res, next) => {
  try {
    const { buffer, filename } = await buildRunComparisonWorkbook(req.params.runId, { scope: scopeFor(req) });
    const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', body.byteLength);
    res.end(body);
  } catch (e) { handle(e, res, next); }
});

marketScraperRouter.post('/runs/:runId/apply', async (req, res, next) => {
  try {
    // force=true bypasses the per-profile autoApply *enable* — used by the manual
    // "Apply now" button. It does NOT bypass the money guardrails: floor/ceiling
    // are still enforced (clamped) and a maxDeltaPct breach is surfaced as a
    // warning (allowed on explicit human intent) rather than a hard HOLD. The
    // cron path never passes force. See market-scrape-correction.service.js.
    const force = req.body?.force === true || req.query?.force === 'true';
    // SEPARATE from force (2026-09-10): force means 'a human pressed Apply now',
    // which every click carries. This one says 'I know this suggestion is far
    // from the live base and I mean it' -- the seed-the-base operation -- so it
    // must be asked for on purpose. Without it an absurd suggestion HOLDs.
    const acknowledgeDataQuality = req.body?.acknowledgeDataQuality === true
      || req.query?.acknowledgeDataQuality === 'true';
    const out = await applyRunSuggestions(req.params.runId, { scope: scopeFor(req), force, mode: 'manual', acknowledgeDataQuality });
    res.json(out);
  } catch (e) { handle(e, res, next); }
});

// ----- Observations -------------------------------------------------------

marketScraperRouter.get('/profiles/:id/observations', async (req, res, next) => {
  try {
    const { runId, pickupDate, sipp, limit } = req.query || {};
    const out = await marketScrapeProfileService.listObservations(req.params.id, scopeFor(req), {
      runId: runId ? String(runId) : undefined,
      pickupDate: pickupDate ? String(pickupDate) : undefined,
      sipp: sipp ? String(sipp) : undefined,
      limit: limit ? Number(limit) : 500
    });
    res.json(out);
  } catch (e) { handle(e, res, next); }
});

// ----- Self-check ---------------------------------------------------------
//
// "quiero un mostrador que ensena estos correciones cuando sucedan" (Hector,
// 2026-09-09). Computed on demand from RateOffer rather than persisted: the
// answer is only ever as good as the last scrape, and a stored copy would go
// stale silently while looking authoritative.
marketScraperRouter.get('/self-check', async (req, res, next) => {
  try {
    res.json(await runSelfCheck(scopeFor(req), {
      locationCode: req.query.locationCode,
      days: req.query.days,
      tolerance: req.query.tolerance,
      minSample: req.query.minSample,
    }));
  } catch (e) { handle(e, res, next); }
});

// ----- Per-brand write targets --------------------------------------------
//
// One scrape can feed several brands, each writing its own Rate (2026-09-09).
// A profile with no rows here keeps using its own targetRateId, so these routes
// are additive: not calling them leaves every profile exactly as it was.
marketScraperRouter.get('/profiles/:id/targets', async (req, res, next) => {
  try {
    res.json(await listProfileTargets(req.params.id, { scope: scopeFor(req) }));
  } catch (e) { handle(e, res, next); }
});

marketScraperRouter.post('/profiles/:id/targets', async (req, res, next) => {
  try {
    res.status(201).json(await createProfileTarget(req.params.id, req.body, { scope: scopeFor(req) }));
  } catch (e) { handle(e, res, next); }
});

marketScraperRouter.patch('/targets/:targetId', async (req, res, next) => {
  try {
    res.json(await updateProfileTarget(req.params.targetId, req.body, { scope: scopeFor(req) }));
  } catch (e) { handle(e, res, next); }
});

marketScraperRouter.delete('/targets/:targetId', async (req, res, next) => {
  try {
    res.json(await deleteProfileTarget(req.params.targetId, { scope: scopeFor(req) }));
  } catch (e) { handle(e, res, next); }
});
