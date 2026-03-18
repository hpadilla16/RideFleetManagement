import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import { commissionsService } from './commissions.service.js';

export const commissionsRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) {
    const tenantId = req.query?.tenantId ? String(req.query.tenantId) : null;
    return tenantId ? { tenantId } : {};
  }
  return { tenantId: req.user?.tenantId || null };
}

function employeeLedgerScope(req) {
  if (isSuperAdmin(req.user) || ['ADMIN', 'OPS'].includes(String(req.user?.role || '').toUpperCase())) {
    return scopeFor(req);
  }
  return { tenantId: req.user?.tenantId || null, employeeUserId: req.user?.sub || null };
}

commissionsRouter.get('/plans', async (req, res, next) => {
  try {
    res.json(await commissionsService.listPlans(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

commissionsRouter.get('/plans/:id', async (req, res, next) => {
  try {
    const row = await commissionsService.getPlan(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Commission plan not found' });
    res.json(row);
  } catch (e) {
    next(e);
  }
});

commissionsRouter.post('/plans', async (req, res, next) => {
  try {
    if (!req.body?.name) return res.status(400).json({ error: 'Missing required field: name' });
    const row = await commissionsService.createPlan(req.body || {}, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

commissionsRouter.patch('/plans/:id', async (req, res) => {
  try {
    res.json(await commissionsService.updatePlan(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Commission plan not found' });
    res.status(400).json({ error: e.message });
  }
});

commissionsRouter.delete('/plans/:id', async (req, res) => {
  try {
    await commissionsService.removePlan(req.params.id, scopeFor(req));
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Commission plan not found' });
  }
});

commissionsRouter.get('/plans/:id/rules', async (req, res) => {
  try {
    res.json(await commissionsService.listRules(req.params.id, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Commission plan not found' });
    res.status(400).json({ error: e.message });
  }
});

commissionsRouter.post('/plans/:id/rules', async (req, res) => {
  try {
    const required = ['name', 'valueType'];
    const missing = required.filter((key) => !req.body?.[key]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    const row = await commissionsService.createRule(req.params.id, req.body || {}, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Commission plan not found' });
    res.status(400).json({ error: e.message });
  }
});

commissionsRouter.patch('/rules/:id', async (req, res) => {
  try {
    res.json(await commissionsService.updateRule(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) {
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Commission rule not found' });
    res.status(400).json({ error: e.message });
  }
});

commissionsRouter.delete('/rules/:id', async (req, res) => {
  try {
    await commissionsService.removeRule(req.params.id, scopeFor(req));
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Commission rule not found' });
  }
});

commissionsRouter.get('/ledger', async (req, res, next) => {
  try {
    const scope = employeeLedgerScope(req);
    const query = {
      ...req.query,
      employeeUserId: scope.employeeUserId || req.query?.employeeUserId || null
    };
    res.json(await commissionsService.ledger(query, scope));
  } catch (e) {
    next(e);
  }
});
