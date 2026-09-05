import { Router } from 'express';
import { partnershipsService } from './partnerships.service.js';
import { AppError } from '../../lib/errors.js';
import { crossTenantScopeFor } from '../../lib/tenant-scope.js';
import { assertPlainObject } from '../../lib/request-validation.js';

/**
 * Partnerships — admin API (2026-09-05).
 * Mounted at /api/partnerships behind requireAuth + tenantRateLimit +
 * requireModuleAccess('partnerships') + requireRole('ADMIN','OPS') (main.js).
 *
 *   GET    /settings                       tenant hosted-domain override
 *   PUT    /settings                       { partnerHostedBaseUrl }
 *   GET    /summary                        KPIs (active, bookings 30d, booked est., visits)
 *   GET    /                               list (decorated: readiness, hosted URL, counts)
 *   POST   /                               { name, slug?, code?, kind? } → DRAFT
 *   GET    /:id                            detail (services, rate items, audit)
 *   PATCH  /:id                            profile / terms / landing / vehicles / discount
 *   POST   /:id/status                     { status } (ACTIVE requires readiness)
 *   POST   /:id/rate                       { copyFromLocationId? } create/link price book
 *   DELETE /:id/rate                       detach price book (switch to discount mode)
 *   PUT    /:id/rate/items                 { items: [{vehicleTypeId, daily, weekly, monthly}] }
 *   GET    /:id/pricing-grid?locationId=   classes × (online daily, partner daily)
 *   PUT    /:id/services                   { services: [{additionalServiceId, rateOverride, mandatory}] }
 *   POST   /:id/services/custom            { name, rate, chargeType, taxable, mandatory }
 *   POST   /:id/logo                       { dataUrl }
 *   GET    /:id/hosted                     { url, qrUrl, published }
 *   GET    /:id/reservations               last 50 attributed reservations
 *
 * SUPER_ADMIN passes ?tenantId= (crossTenantScopeFor returns {} otherwise and
 * the service refuses to operate "in the void").
 */
export const partnershipsRouter = Router();

function ctxFor(req) {
  const scope = crossTenantScopeFor(req);
  const tenantId = scope?.tenantId
    || (req.query?.tenantId ? String(req.query.tenantId) : null)
    || (req.body?.tenantId ? String(req.body.tenantId) : null);
  return { tenantId, actor: req.user };
}

function send(res, next) {
  return (err) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
    return next(err);
  };
}

partnershipsRouter.get('/settings', (req, res, next) => {
  partnershipsService.getSettings(ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.put('/settings', (req, res, next) => {
  try { assertPlainObject(req.body, 'payload'); } catch (e) { return res.status(400).json({ error: e.message }); }
  partnershipsService.updateSettings(req.body, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.get('/summary', (req, res, next) => {
  partnershipsService.summary(ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.get('/', (req, res, next) => {
  partnershipsService.list(ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.post('/', (req, res, next) => {
  try { assertPlainObject(req.body, 'payload'); } catch (e) { return res.status(400).json({ error: e.message }); }
  partnershipsService.create(req.body, ctxFor(req)).then((out) => res.status(201).json(out)).catch(send(res, next));
});

partnershipsRouter.get('/:id', (req, res, next) => {
  partnershipsService.getById(req.params.id, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.patch('/:id', (req, res, next) => {
  try { assertPlainObject(req.body, 'payload'); } catch (e) { return res.status(400).json({ error: e.message }); }
  partnershipsService.update(req.params.id, req.body, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.post('/:id/status', (req, res, next) => {
  partnershipsService.setStatus(req.params.id, req.body?.status, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.post('/:id/rate', (req, res, next) => {
  partnershipsService.ensureRate(req.params.id, { copyFromLocationId: req.body?.copyFromLocationId || null }, ctxFor(req))
    .then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.delete('/:id/rate', (req, res, next) => {
  partnershipsService.detachRate(req.params.id, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.put('/:id/rate/items', (req, res, next) => {
  partnershipsService.setRateItems(req.params.id, req.body?.items, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.get('/:id/pricing-grid', (req, res, next) => {
  partnershipsService.pricingGrid(req.params.id, { locationId: req.query?.locationId ? String(req.query.locationId) : null }, ctxFor(req))
    .then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.put('/:id/services', (req, res, next) => {
  partnershipsService.setServices(req.params.id, req.body?.services, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.post('/:id/services/custom', (req, res, next) => {
  try { assertPlainObject(req.body, 'payload'); } catch (e) { return res.status(400).json({ error: e.message }); }
  partnershipsService.createCustomService(req.params.id, req.body, ctxFor(req)).then((out) => res.status(201).json(out)).catch(send(res, next));
});

partnershipsRouter.post('/:id/logo', (req, res, next) => {
  partnershipsService.saveLogo(req.params.id, req.body?.dataUrl, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.get('/:id/hosted', (req, res, next) => {
  partnershipsService.hosted(req.params.id, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});

partnershipsRouter.get('/:id/reservations', (req, res, next) => {
  partnershipsService.reservations(req.params.id, ctxFor(req)).then((out) => res.json(out)).catch(send(res, next));
});
