import { Router } from 'express';
import { locationsService } from './locations.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

export const locationsRouter = Router();

locationsRouter.get('/', async (_req, res, next) => {
  try { res.json(await locationsService.list(scopeFor(_req))); } catch (e) { next(e); }
});

locationsRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await locationsService.getById(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Location not found' });
    res.json(row);
  } catch (e) { next(e); }
});

locationsRouter.post('/', async (req, res, next) => {
  try {
    const required = ['code', 'name'];
    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    const row = await locationsService.create(req.body, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'A location with that code already exists in this tenant' });
    next(e);
  }
});

locationsRouter.patch('/:id', async (req, res, next) => {
  try { res.json(await locationsService.update(req.params.id, req.body || {}, scopeFor(req))); }
  catch (e) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'A location with that code already exists in this tenant' });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Location not found' });
    next(e);
  }
});

locationsRouter.delete('/:id', async (req, res) => {
  try { await locationsService.remove(req.params.id, scopeFor(req)); res.status(204).send(); }
  catch { res.status(404).json({ error: 'Location not found' }); }
});

