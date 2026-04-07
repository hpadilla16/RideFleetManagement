import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { isSuperAdmin } from '../../middleware/auth.js';
import { carSharingService } from './car-sharing.service.js';
import { carSharingScopeFor as scopeFor } from '../../lib/tenant-scope.js';

export const carSharingRouter = Router();

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
      status: req.query?.status ? String(req.query.status).toUpperCase() : undefined,
      page: req.query?.page,
      limit: req.query?.limit
    }));
  } catch (e) {
    next(e);
  }
});

carSharingRouter.get('/trips', async (req, res, next) => {
  try {
    const scope = scopeFor(req);
    res.json(await carSharingService.listTrips({
      ...scope,
      listingId: req.query?.listingId ? String(req.query.listingId) : undefined,
      status: req.query?.status ? String(req.query.status).toUpperCase() : undefined,
      page: req.query?.page,
      limit: req.query?.limit
    }));
  } catch (e) {
    next(e);
  }
});

carSharingRouter.get('/listings/:id/availability', async (req, res, next) => {
  try {
    res.json(await carSharingService.listAvailabilityWindows(req.params.id, scopeFor(req)));
  } catch (e) {
    res.status(404).json({ error: e.message });
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

carSharingRouter.post('/trips', async (req, res, next) => {
  try {
    const row = await carSharingService.createTrip({
      ...(req.body || {}),
      actorUserId: req.user?.sub || req.user?.id || null
    }, scopeFor(req));
    res.status(201).json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

carSharingRouter.patch('/trips/:id/status', async (req, res, next) => {
  try {
    res.json(await carSharingService.updateTripStatus(req.params.id, {
      ...(req.body || {}),
      actorUserId: req.user?.sub || req.user?.id || null
    }, scopeFor(req)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

carSharingRouter.post('/trips/:id/provision-workflow', async (req, res, next) => {
  try {
    res.json(await carSharingService.ensureTripWorkflow(req.params.id, {
      ...scopeFor(req),
      actorUserId: req.user?.sub || req.user?.id || null
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

carSharingRouter.post('/listings/:id/availability', async (req, res, next) => {
  try {
    const row = await carSharingService.createAvailabilityWindow(req.params.id, req.body || {}, scopeFor(req));
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

carSharingRouter.patch('/availability/:id', async (req, res, next) => {
  try {
    res.json(await carSharingService.updateAvailabilityWindow(req.params.id, req.body || {}, scopeFor(req)));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

carSharingRouter.delete('/availability/:id', async (req, res, next) => {
  try {
    res.json(await carSharingService.deleteAvailabilityWindow(req.params.id, scopeFor(req)));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

carSharingRouter.get('/ops/handoff-alerts', async (req, res, next) => {
  try {
    res.json(await carSharingService.listHandoffConfirmationAlerts({
      ...scopeFor(req),
      warningHours: req.query?.warningHours ? Number(req.query.warningHours) : 24
    }));
  } catch (e) {
    next(e);
  }
});

carSharingRouter.post('/ops/send-handoff-reminders', async (req, res, next) => {
  try {
    res.json(await carSharingService.sendHandoffConfirmationReminders({
      ...scopeFor(req),
      warningHours: req.body?.warningHours ?? 24
    }));
  } catch (e) {
    next(e);
  }
});

carSharingRouter.get('/search-places/pending', async (req, res, next) => {
  try {
    res.json(await carSharingService.listPendingSearchPlaces(scopeFor(req)));
  } catch (e) {
    next(e);
  }
});

carSharingRouter.patch('/search-places/:id/approve', async (req, res, next) => {
  try {
    res.json(await carSharingService.approveSearchPlace(req.params.id, scopeFor(req)));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

carSharingRouter.patch('/search-places/:id/reject', async (req, res, next) => {
  try {
    res.json(await carSharingService.rejectSearchPlace(req.params.id, {
      reason: req.body?.reason || '',
      ...scopeFor(req)
    }));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});
