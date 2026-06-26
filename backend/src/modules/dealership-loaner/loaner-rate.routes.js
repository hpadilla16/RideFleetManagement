import { Router } from 'express';
import { loanerRateService } from './loaner-rate.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

// Loaner Program per-class rate book admin (2026-06-25). Mounted at /api/settings/loaner-rates
// (ADMIN/OPS, settings module). GET lists every class + its loaner daily rate; PUT upserts rates.
export const loanerRateRouter = Router();

loanerRateRouter.get('/', async (req, res, next) => {
  try { res.json(await loanerRateService.listForAdmin(scopeFor(req))); }
  catch (e) { next(e); }
});

loanerRateRouter.put('/', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.rates) ? req.body.rates : (Array.isArray(req.body) ? req.body : []);
    res.json(await loanerRateService.upsertRates(scopeFor(req), items));
  } catch (e) { next(e); }
});
