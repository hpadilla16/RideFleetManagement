import { Router } from 'express';
import { isSuperAdmin } from '../../middleware/auth.js';
import { carSharingService } from './car-sharing.service.js';

export const carSharingRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId ? { tenantId: String(req.query.tenantId) } : {};
  }
  return { tenantId: req.user?.tenantId || null };
}

carSharingRouter.get('/hosts', async (req, res, next) => {
  try {
    res.json(await carSharingService.listHosts(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

carSharingRouter.post('/hosts', async (req, res, next) => {
  try {
    const row = await carSharingService.createHost(req.body || {}, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

carSharingRouter.patch('/hosts/:id', async (req, res, next) => {
  try {
    res.json(await carSharingService.updateHost(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

carSharingRouter.get('/listings', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    res.json(await carSharingService.listListings({
      ...scope,
      hostProfileId: req.query?.hostProfileId ? String(req.query.hostProfileId) : undefined,
      status: req.query?.status ? String(req.query.status).toUpperCase() : undefined
    }));
  } catch (e) {
    next(e);
  }
});

carSharingRouter.post('/listings', async (req, res, next) => {
  try {
    const row = await carSharingService.createListing(req.body || {}, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

carSharingRouter.patch('/listings/:id', async (req, res, next) => {
  try {
    res.json(await carSharingService.updateListing(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});
