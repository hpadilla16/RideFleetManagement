import { Router } from 'express';
import { stopSalesService } from './stop-sales.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

export const stopSalesRouter = Router();

stopSalesRouter.get('/', async (req, res, next) => {
  try { res.json(await stopSalesService.list(scopeFor(req))); }
  catch (e) { next(e); }
});

stopSalesRouter.get('/:id', async (req, res) => {
  try {
    const row = await stopSalesService.getById(req.params.id, scopeFor(req));
    if (!row) return res.status(404).json({ error: 'Stop sale not found' });
    res.json(row);
  } catch { res.status(404).json({ error: 'Stop sale not found' }); }
});

stopSalesRouter.post('/', async (req, res, next) => {
  try {
    const required = ['vehicleTypeId', 'startDate', 'endDate'];
    const missing = required.filter((k) => !req.body?.[k]);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    res.status(201).json(await stopSalesService.create(req.body || {}, scopeFor(req)));
  } catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes('Vehicle type not found')
      || msg.includes('endDate must be after startDate')
      || msg.includes('valid dates')
      || msg.includes('tenantId is required')
      || msg.includes('vehicleTypeId is required')) {
      return res.status(400).json({ error: msg });
    }
    next(e);
  }
});

stopSalesRouter.patch('/:id', async (req, res, next) => {
  try { res.json(await stopSalesService.update(req.params.id, req.body || {}, scopeFor(req))); }
  catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes('Stop sale not found')) return res.status(404).json({ error: 'Stop sale not found' });
    if (msg.includes('Vehicle type not found')
      || msg.includes('endDate must be after startDate')) {
      return res.status(400).json({ error: msg });
    }
    next(e);
  }
});

stopSalesRouter.delete('/:id', async (req, res) => {
  try { await stopSalesService.remove(req.params.id, scopeFor(req)); res.status(204).send(); }
  catch { res.status(404).json({ error: 'Stop sale not found' }); }
});
