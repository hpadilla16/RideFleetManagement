import { Router } from 'express';
import { feesService } from './fees.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';

export const feesRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return {};
  return { tenantId: req.user?.tenantId || null };
}

feesRouter.get('/', async (_req, res, next) => {
  try { res.json(await feesService.list(scopeFor(_req))); } catch (e) { next(e); }
});

feesRouter.post('/', async (req, res, next) => {
  try {
    const required = ['name', 'mode'];
    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    res.status(201).json(await feesService.create(req.body || {}, scopeFor(req)));
  } catch (e) { next(e); }
});

feesRouter.patch('/:id', async (req, res) => {
  try { res.json(await feesService.update(req.params.id, req.body || {}, scopeFor(req))); }
  catch { res.status(404).json({ error: 'Fee not found' }); }
});

feesRouter.delete('/:id', async (req, res) => {
  try { await feesService.remove(req.params.id, scopeFor(req)); res.status(204).send(); }
  catch { res.status(404).json({ error: 'Fee not found' }); }
});

