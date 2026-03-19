import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { isSuperAdmin } from '../../middleware/auth.js';
import { carSharingService } from './car-sharing.service.js';

export const carSharingRouter = Router();

function scopeFor(req) {
  if (isSuperAdmin(req.user)) {
    return req.query?.tenantId ? { tenantId: String(req.query.tenantId), allowUnassigned: true } : { allowUnassigned: true };
  }
  return { tenantId: req.user?.tenantId || null, allowUnassigned: false };
}

async function ensureCarSharingEnabled(req, res, next) {
  try {
    if (isSuperAdmin(req.user)) return next();
    const tenantId = req.user?.tenantId || null;
    if (!tenantId) return res.status(403).json({ error: 'Car sharing is not enabled for this tenant' });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { carSharingEnabled: true } });
    if (!tenant?.carSharingEnabled) return res.status(403).json({ error: 'Car sharing is not enabled for this tenant' });
    next();
  } catch (e) {
    next(e);
  }
}

carSharingRouter.use(ensureCarSharingEnabled);

carSharingRouter.get('/config', async (req, res, next) => {
  try {
    const tenantId = isSuperAdmin(req.user) ? (req.query?.tenantId ? String(req.query.tenantId) : null) : (req.user?.tenantId || null);
    if (!tenantId) return res.json({ enabled: isSuperAdmin(req.user), tenantId: null });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, carSharingEnabled: true } });
    res.json({
      enabled: !!tenant?.carSharingEnabled || isSuperAdmin(req.user),
      tenantId: tenant?.id || tenantId,
      tenantName: tenant?.name || null
    });
  } catch (e) {
    next(e);
  }
});

carSharingRouter.get('/eligible-vehicles', async (req, res, next) => {
  try {
    res.json(await carSharingService.listEligibleVehicles(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

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
