import { Router } from 'express';
import { vehiclesService } from './vehicles.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';

export const vehiclesRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return {};
  return { tenantId: req.user?.tenantId || null };
}

vehiclesRouter.get('/', async (_req, res) => {
  res.json(await vehiclesService.list(scopeFor(_req)));
});

vehiclesRouter.get('/:id', async (req, res) => {
  const row = await vehiclesService.getById(req.params.id, scopeFor(req));
  if (!row) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(row);
});

vehiclesRouter.post('/', async (req, res) => {
  const required = ['internalNumber', 'vehicleTypeId'];
  const missing = required.filter((k) => !req.body?.[k]);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  const row = await vehiclesService.create(req.body, scopeFor(req));
  res.status(201).json(row);
});

vehiclesRouter.post('/bulk/validate', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const report = await vehiclesService.validateBulk(rows, scopeFor(req));
  res.json(report);
});

vehiclesRouter.post('/bulk/import', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const out = await vehiclesService.importBulk(rows, scopeFor(req));
  res.json(out);
});

vehiclesRouter.patch('/:id', async (req, res) => {
  try {
    const row = await vehiclesService.update(req.params.id, req.body || {}, scopeFor(req));
    res.json(row);
  } catch {
    res.status(404).json({ error: 'Vehicle not found' });
  }
});

vehiclesRouter.delete('/:id', async (req, res) => {
  try {
    await vehiclesService.remove(req.params.id, scopeFor(req));
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'Vehicle not found' });
  }
});

