import { Router } from 'express';
import { hostAppService } from './host-app.service.js';
import { hostMessagingRouter } from '../messaging/messaging.routes.js';

export const hostAppRouter = Router();

// Attach host context for messaging sub-routes
hostAppRouter.use('/messages', async (req, res, next) => {
  try {
    const access = await hostAppService.getAccess(req.user);
    req.hostProfileId = access?.hostProfileId || null;
    req.hostDisplayName = access?.hostDisplayName || '';
    next();
  } catch { next(); }
}, hostMessagingRouter);

hostAppRouter.get('/access', async (req, res, next) => {
  try {
    res.json(await hostAppService.getAccess(req.user));
  } catch (error) {
    next(error);
  }
});

hostAppRouter.get('/dashboard', async (req, res, next) => {
  try {
    res.json(await hostAppService.getDashboard(req.user, {
      hostProfileId: req.query?.hostProfileId ? String(req.query.hostProfileId) : undefined,
      tripStatus: req.query?.tripStatus ? String(req.query.tripStatus) : undefined
    }));
  } catch (error) {
    if (/not found|linked/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

hostAppRouter.get('/listings/:id/availability', async (req, res, next) => {
  try {
    res.json(await hostAppService.listAvailability(req.user, req.params.id));
  } catch (error) {
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

hostAppRouter.post('/listings/:id/availability', async (req, res, next) => {
  try {
    res.status(201).json(await hostAppService.createAvailability(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
});

hostAppRouter.patch('/availability/:id', async (req, res, next) => {
  try {
    res.json(await hostAppService.updateAvailability(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
});

hostAppRouter.delete('/availability/:id', async (req, res, next) => {
  try {
    res.json(await hostAppService.deleteAvailability(req.user, req.params.id));
  } catch (error) {
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
});

hostAppRouter.patch('/listings/:id', async (req, res, next) => {
  try {
    res.json(await hostAppService.updateListing(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
});

hostAppRouter.patch('/trips/:id/status', async (req, res, next) => {
  try {
    res.json(await hostAppService.updateTripStatus(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    res.status(400).json({ error: error.message });
  }
});

hostAppRouter.patch('/trips/:id/fulfillment-plan', async (req, res, next) => {
  try {
    res.json(await hostAppService.updateTripFulfillmentPlan(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|linked|handoff|fulfillment/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

hostAppRouter.post('/trips/:id/incidents', async (req, res, next) => {
  try {
    res.status(201).json(await hostAppService.createTripIncident(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

hostAppRouter.post('/vehicle-submissions', async (req, res, next) => {
  try {
    res.status(201).json(await hostAppService.createVehicleSubmission(req.user, req.body || {}));
  } catch (error) {
    if (/not found|required|linked/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

hostAppRouter.post('/pickup-spots', async (req, res, next) => {
  try {
    res.status(201).json(await hostAppService.createPickupSpot(req.user, req.body || {}));
  } catch (error) {
    if (/not found|required|linked|pickup spot|anchor/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

hostAppRouter.patch('/pickup-spots/:id', async (req, res, next) => {
  try {
    res.json(await hostAppService.updatePickupSpot(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|linked|pickup spot|anchor/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

hostAppRouter.post('/listings/:id/discovery-sync', async (req, res, next) => {
  try {
    res.json(await hostAppService.syncListingDiscovery(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|linked|discovery/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

hostAppRouter.patch('/search-places/:id', async (req, res, next) => {
  try {
    res.json(await hostAppService.updateSearchPlace(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|linked|search place/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

hostAppRouter.patch('/service-areas/:id', async (req, res, next) => {
  try {
    res.json(await hostAppService.updateServiceArea(req.user, req.params.id, req.body || {}));
  } catch (error) {
    if (/not found|required|linked|service area/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});
