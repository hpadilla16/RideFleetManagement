import { Router } from 'express';
import { additionalServicesService } from './additional-services.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

export const additionalServicesRouter = Router();

additionalServicesRouter.get('/', async (req, res, next) => {
  try {
    const rows = await additionalServicesService.list({
      locationId: req.query?.locationId ? String(req.query.locationId) : undefined,
      activeOnly: req.query?.activeOnly === '1' || req.query?.activeOnly === 'true',
      tenantId: scopeFor(req).tenantId
    });
    res.json(rows);
  } catch (e) { next(e); }
});

additionalServicesRouter.get('/:id', async (req, res, next) => {
  try {
    const row = await additionalServicesService.getById(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Additional service not found' });
    res.json(row);
  } catch (e) { next(e); }
});

additionalServicesRouter.post('/', async (req, res, next) => {
  try {
    const required = ['name'];
    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    const row = await additionalServicesService.create(req.body || {}, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    if (String(e?.message || '').includes('Linked fee not found')) {
      return res.status(400).json({ error: 'Linked fee not found for this tenant' });
    }
    next(e);
  }
});

additionalServicesRouter.patch('/:id', async (req, res) => {
  try { res.json(await additionalServicesService.update(req.params.id, req.body || {}, scopeFor(req))); }
  catch (e) {
    if (String(e?.message || '').includes('Linked fee not found')) {
      return res.status(400).json({ error: 'Linked fee not found for this tenant' });
    }
    res.status(404).json({ error: 'Additional service not found' });
  }
});

additionalServicesRouter.delete('/:id', async (req, res) => {
  try { await additionalServicesService.remove(req.params.id, scopeFor(req)); res.status(204).send(); }
  catch { res.status(404).json({ error: 'Additional service not found' }); }
});

