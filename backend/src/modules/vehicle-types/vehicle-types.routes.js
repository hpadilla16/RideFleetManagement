import { Router } from 'express';
import { vehicleTypesService } from './vehicle-types.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';

export const vehicleTypesRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return {};
  return { tenantId: req.user?.tenantId || null };
}

vehicleTypesRouter.get('/', async (_req, res, next) => {
  try { res.json(await vehicleTypesService.list(scopeFor(_req))); } catch (e) { next(e); }
});

vehicleTypesRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await vehicleTypesService.getById(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Vehicle type not found' });
    res.json(row);
  } catch (e) { next(e); }
});

vehicleTypesRouter.post('/', async (req, res, next) => {
  try {
    const required = ['code', 'name'];
    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    const row = await vehicleTypesService.create(req.body, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Vehicle type code must be unique.' });
    next(e);
  }
});

vehicleTypesRouter.patch('/:id', async (req, res, next) => {
  try {
    res.json(await vehicleTypesService.update(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) {
    if (e?.message === 'Vehicle type not found') return res.status(404).json({ error: 'Vehicle type not found' });
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Vehicle type code must be unique.' });
    next(e);
  }
});

vehicleTypesRouter.delete('/:id', async (req, res) => {
  try { await vehicleTypesService.remove(req.params.id, scopeFor(req)); res.status(204).send(); }
  catch { res.status(404).json({ error: 'Vehicle type not found' }); }
});

