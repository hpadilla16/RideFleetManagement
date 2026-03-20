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
      hostProfileId: req.query?.hostProfileId ? String(req.query.hostProfileId) : undefined
    }));
  } catch (error) {
    if (/not found|linked/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
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
