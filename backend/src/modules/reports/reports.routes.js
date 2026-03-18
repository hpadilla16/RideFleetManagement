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

reportsRouter.get('/overview.csv', async (req, res, next) => {
  try {
    const csv = await reportsService.overviewCsv(req.query || {}, scopeFor(req));
    const start = String(req.query?.start || '').trim() || 'range-start';
    const end = String(req.query?.end || '').trim() || 'range-end';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reports-overview-${start}-to-${end}.csv"`);
    res.send(csv);
  } catch (e) {
    next(e);
  }
});
