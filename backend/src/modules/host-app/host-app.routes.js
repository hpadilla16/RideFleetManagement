import { Router } from 'express';
import { hostAppService } from './host-app.service.js';

export const hostAppRouter = Router();

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
