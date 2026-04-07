import { Router } from 'express';
import { requireRole } from '../../middleware/auth.js';
import { scopeFor } from '../../lib/tenant-scope.js';
import { reportsService } from './reports.service.js';

export const reportsRouter = Router();

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

reportsRouter.post('/overview/email', requireRole('ADMIN', 'OPS'), async (req, res, next) => {
  try {
    const out = await reportsService.sendOverviewEmail(req.body || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

reportsRouter.get('/services-sold', async (req, res, next) => {
  try {
    const out = await reportsService.servicesSold(req.query || {}, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});
