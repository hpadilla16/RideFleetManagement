import { Router } from 'express';
import { ratesService } from './rates.service.js';
import { scopeFor } from '../../lib/tenant-scope.js';

export const ratesRouter = Router();

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

ratesRouter.get('/revenue-recommendation', async (req, res, next) => {
  try {
    const { vehicleTypeId, pickupLocationId, pickupAt, returnAt, displayOnline } = req.query || {};
    if (!vehicleTypeId || !pickupAt || !returnAt) {
      return res.status(400).json({ error: 'vehicleTypeId, pickupAt, returnAt are required' });
    }
    const out = await ratesService.getRevenueRecommendation({
      vehicleTypeId: String(vehicleTypeId),
      pickupLocationId: pickupLocationId ? String(pickupLocationId) : null,
      pickupAt: String(pickupAt),
      returnAt: String(returnAt)
    }, scopeFor(req), {
      displayOnline: String(displayOnline || '').trim().toLowerCase() === 'true'
    });
    if (!out) return res.status(404).json({ error: 'No matching active rate found' });
    res.json(out);
  } catch (e) { next(e); }
});

ratesRouter.post('/', async (req, res, next) => {
  try {
    if (!req.body?.rateCode) return res.status(400).json({ error: 'Missing required field: rateCode' });
    res.status(201).json(await ratesService.create(req.body || {}, scopeFor(req)));
  } catch (e) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'A rate with that code already exists for this tenant' });
    next(e);
  }
});

// Auto-detect rate(s) for a Location.code from the suggestion report. Used by
// the Excel import flow so the user doesn't have to manually pick a Rate when
// the Excel already says which station the prices are for.
ratesRouter.get('/lookup-by-location/:code', async (req, res, next) => {
  try {
    const out = await ratesService.findRatesByLocationCode(req.params.code, scopeFor(req));
    res.json(out);
  } catch (e) { next(e); }
});

// Parse an uploaded .xlsx (sent as { excelBase64, filename } JSON) into normalized
// daily-price rows. This does NOT commit anything — frontend uses it to drive
// the auto-detect-rate flow then calls /validate or /import with the rows.
ratesRouter.post('/parse-excel', async (req, res, next) => {
  try {
    const { excelBase64, filename } = req.body || {};
    const out = await ratesService.parseDailyPriceExcel({ base64: excelBase64, filename });
    res.json(out);
  } catch (e) {
    if (/required|empty|could not|expected headers/i.test(String(e?.message || ''))) {
      return res.status(400).json({ error: e.message });
    }
    next(e);
  }
});

ratesRouter.post('/:id/daily-prices/validate', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    res.json(await ratesService.validateDailyPrices(req.params.id, rows, scopeFor(req)));
  } catch (e) {
    if (/rate not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

ratesRouter.post('/:id/daily-prices/import', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    res.json(await ratesService.importDailyPrices(req.params.id, rows, scopeFor(req)));
  } catch (e) {
    if (/rate not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

ratesRouter.delete('/:id/daily-prices/:dailyPriceId', async (req, res, next) => {
  try {
    res.json(await ratesService.removeDailyPrice(req.params.id, req.params.dailyPriceId, scopeFor(req)));
  } catch (e) {
    if (/rate not found|daily price not found/i.test(String(e?.message || ''))) return res.status(404).json({ error: e.message });
    next(e);
  }
});

ratesRouter.patch('/:id', async (req, res, next) => {
  try {
    const out = await ratesService.update(req.params.id, req.body || {}, scopeFor(req));
    if (!out) return res.status(404).json({ error: 'Rate not found' });
    res.json(out);
  } catch (e) {
    if (e?.code === 'P2025') return res.status(404).json({ error: 'Rate not found' });
    if (e?.code === 'P2002') return res.status(409).json({ error: 'A rate with that code already exists for this tenant' });
    next(e);
  }
});

ratesRouter.delete('/:id', async (req, res) => {
  try { await ratesService.remove(req.params.id, scopeFor(req)); res.status(204).send(); }
  catch { res.status(404).json({ error: 'Rate not found' }); }
});
