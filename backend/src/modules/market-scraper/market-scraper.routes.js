import { Router } from 'express';
import { marketScrapeProfileService } from './market-scrape-profile.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

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
 *   GET    /api/market-scraper/runs/:runId/cheapest  (per-(date,sipp) cheapest)
 *
 *   GET    /api/market-scraper/profiles/:id/observations
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
