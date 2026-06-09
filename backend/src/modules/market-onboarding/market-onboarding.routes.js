import { Router } from 'express';
import { scopeFor } from '../../lib/tenant-scope.js';
import { marketOnboardingService } from './market-onboarding.service.js';

/**
 * Market Intelligence onboarding wizard routes (beta.135). Tenant-scoped,
 * mounted behind requireModuleAccess('marketIntelligence') + ADMIN/OPS in
 * main.js.
 *
 *   GET  /api/market-onboarding/state        wizard snapshot (VTs, profiles, rules)
 *   POST /api/market-onboarding/airports     step 1: create scrape profile trio
 *   POST /api/market-onboarding/discovery    step 2: distinct SIPPs from observations
 *   POST /api/market-onboarding/apply        steps 3+4: create Rate+RateItem+PricingRule (SUGGEST)
 */
export const marketOnboardingRouter = Router();

function handle(err, res, next) {
  if (err?.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
  return next(err);
}

marketOnboardingRouter.get('/state', async (req, res, next) => {
  try {
    res.json(await marketOnboardingService.getState(scopeFor(req)));
  } catch (e) { handle(e, res, next); }
});

marketOnboardingRouter.post('/airports', async (req, res, next) => {
  try {
    res.status(201).json(await marketOnboardingService.createAirportProfiles(req.body || {}, scopeFor(req), req.user?.id ?? req.user?.sub ?? null));
  } catch (e) { handle(e, res, next); }
});

marketOnboardingRouter.post('/discovery', async (req, res, next) => {
  try {
    res.json(await marketOnboardingService.getDiscovery(req.body || {}, scopeFor(req)));
  } catch (e) { handle(e, res, next); }
});

marketOnboardingRouter.post('/apply', async (req, res, next) => {
  try {
    res.json(await marketOnboardingService.applyMapping(req.body || {}, scopeFor(req), req.user?.id ?? req.user?.sub ?? null));
  } catch (e) { handle(e, res, next); }
});
