import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import { reportsService } from './reports.service.js';

export const reportsRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return {};
  return { tenantId: req.user?.tenantId || null };
}

reportsRouter.get('/overview', async (req, res, next) => {
  try {
    const out = await reportsService.overview(req.query || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});
