import { Router } from 'express';
import { vehiclesService } from './vehicles.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';

export const vehiclesRouter = Router();

function vehicleDuplicateMessage(error) {
  const target = Array.isArray(error?.meta?.target) ? error.meta.target.map((item) => String(item)) : [];
  if (target.includes('plate')) return 'A vehicle with that plate already exists in this tenant';
  if (target.includes('vin')) return 'A vehicle with that VIN already exists';
  return 'A vehicle with that internal number already exists in this tenant';
}

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return req.query?.tenantId ? { allowCrossTenant: true, tenantId: String(req.query.tenantId) } : { allowCrossTenant: true };
  return { tenantId: req.user?.tenantId || null, allowCrossTenant: false };
}

vehiclesRouter.get('/', async (_req, res) => {
  res.json(await vehiclesService.list(scopeFor(_req)));
});

vehiclesRouter.get('/:id', async (req, res) => {
  const row = await vehiclesService.getById(req.params.id, scopeFor(req));
  if (!row) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(row);
});

vehiclesRouter.post('/', async (req, res, next) => {
  const required = ['internalNumber', 'vehicleTypeId'];
  const missing = required.filter((k) => !req.body?.[k]);
  if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

  try {
    const row = await vehiclesService.create(req.body, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: vehicleDuplicateMessage(e) });
    }
    next(e);
  }
});

vehiclesRouter.post('/bulk/validate', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const report = await vehiclesService.validateBulk(rows, scopeFor(req));
  res.json(report);
});

vehiclesRouter.post('/bulk/import', async (req, res, next) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  try {
    const out = await vehiclesService.importBulk(rows, scopeFor(req));
    res.json(out);
  } catch (e) {
    if (e?.code === 'P2002') {
      return res.status(409).json({ error: 'One or more vehicles already exist in this tenant by unit ID, plate, or VIN. Re-run validation and refresh the inventory list.' });
    }
    next(e);
  }
});

vehiclesRouter.post('/availability-blocks/validate', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const report = await vehiclesService.validateBulkAvailabilityBlocks(rows, scopeFor(req));
  res.json(report);
});

vehiclesRouter.post('/availability-blocks/import', async (req, res, next) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  try {
    const out = await vehiclesService.importBulkAvailabilityBlocks(rows, scopeFor(req));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

vehiclesRouter.post('/:id/availability-blocks', async (req, res, next) => {
  try {
    const row = await vehiclesService.createAvailabilityBlock(req.params.id, req.body || {}, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (/Vehicle not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Vehicle not found' });
    if (/availableFrom is required|availableFrom must be after blockedFrom|blockType is invalid/i.test(String(e?.message || ''))) return res.status(400).json({ error: String(e.message) });
    next(e);
  }
});

vehiclesRouter.post('/availability-blocks/:id/release', async (req, res, next) => {
  try {
    const row = await vehiclesService.releaseAvailabilityBlock(req.params.id, scopeFor(req));
    res.json(row);
  } catch (e) {
    if (/Availability block not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Availability block not found' });
    next(e);
  }
});

vehiclesRouter.patch('/:id', async (req, res, next) => {
  try {
    const row = await vehiclesService.update(req.params.id, req.body || {}, scopeFor(req));
    res.json(row);
  } catch (e) {
    if (e?.code === 'P2002') return res.status(409).json({ error: vehicleDuplicateMessage(e) });
    if (/not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: 'Vehicle not found' });
    next(e);
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

