import { Router } from 'express';
import { feesService } from './fees.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

export const feesRouter = Router();

feesRouter.get('/', async (_req, res, next) => {
  try { res.json(await feesService.list(scopeFor(_req))); } catch (e) { next(e); }
});

feesRouter.post('/', async (req, res, next) => {
  try {
    const required = ['name', 'mode'];
    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    res.status(201).json(await feesService.create(req.body || {}, scopeFor(req)));
  } catch (e) {
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: 'A fee with that code already exists for this tenant' });
    }
    next(e);
  }
});

feesRouter.patch('/:id', async (req, res, next) => {
  try { res.json(await feesService.update(req.params.id, req.body || {}, scopeFor(req))); }
  catch (e) {
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: 'A fee with that code already exists for this tenant' });
    }
    if (String(e?.message || '').includes('Fee not found')) {
      return res.status(404).json({ error: 'Fee not found' });
    }
    next(e);
  }
});

feesRouter.delete('/:id', async (req, res) => {
  try { await feesService.remove(req.params.id, scopeFor(req)); res.status(204).send(); }
  catch { res.status(404).json({ error: 'Fee not found' }); }
});

