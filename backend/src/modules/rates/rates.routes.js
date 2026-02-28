import { Router } from 'express';
import { ratesService } from './rates.service.js';
import { isSuperAdmin } from '../../middleware/auth.js';

export const ratesRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) return {};
  return { tenantId: req.user?.tenantId || null };
}

ratesRouter.get('/', async (req, res, next) => {
  try { res.json(await ratesService.list({ query: req.query?.query ? String(req.query.query) : '' }, scopeFor(req))); }
  catch (e) { next(e); }
});

ratesRouter.get('/resolve', async (req, res, next) => {
  try {
    const { vehicleTypeId, pickupLocationId, pickupAt, returnAt } = req.query || {};
    if (!vehicleTypeId || !pickupAt || !returnAt) {
      return res.status(400).json({ error: 'vehicleTypeId, pickupAt, returnAt are required' });
    }
    const out = await ratesService.resolveForRental({
      vehicleTypeId: String(vehicleTypeId),
      pickupLocationId: pickupLocationId ? String(pickupLocationId) : null,
      pickupAt: String(pickupAt),
      returnAt: String(returnAt)
    }, scopeFor(req));
    if (!out) return res.status(404).json({ error: 'No matching active rate found' });
    res.json(out);
  } catch (e) { next(e); }
});

ratesRouter.post('/', async (req, res, next) => {
  try {
    if (!req.body?.rateCode) return res.status(400).json({ error: 'Missing required field: rateCode' });
    res.status(201).json(await ratesService.create(req.body || {}, scopeFor(req)));
  } catch (e) { next(e); }
});

ratesRouter.patch('/:id', async (req, res, next) => {
  try {
    const out = await ratesService.update(req.params.id, req.body || {}, scopeFor(req));
    if (!out) return res.status(404).json({ error: 'Rate not found' });
    res.json(out);
  } catch (e) {
    if (e?.code === 'P2025') return res.status(404).json({ error: 'Rate not found' });
    next(e);
  }
});

ratesRouter.delete('/:id', async (req, res) => {
  try { await ratesService.remove(req.params.id, scopeFor(req)); res.status(204).send(); }
  catch { res.status(404).json({ error: 'Rate not found' }); }
});

