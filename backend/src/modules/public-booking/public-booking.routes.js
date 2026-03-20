import { Router } from 'express';
import { publicBookingService } from './public-booking.service.js';

export const publicBookingRouter = Router();

publicBookingRouter.get('/bootstrap', async (req, res, next) => {
  try {
    const payload = await publicBookingService.getBootstrap({
      tenantId: req.query?.tenantId ? String(req.query.tenantId) : undefined,
      tenantSlug: req.query?.tenantSlug ? String(req.query.tenantSlug) : undefined
    });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

publicBookingRouter.post('/rental-search', async (req, res, next) => {
  try {
    const payload = await publicBookingService.searchRentalQuotes(req.body || {});
    res.json(payload);
  } catch (error) {
    if (/required|not found|not enabled|after/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/car-sharing-search', async (req, res, next) => {
  try {
    const payload = await publicBookingService.searchCarSharingListings(req.body || {});
    res.json(payload);
  } catch (error) {
    if (/required|not found|not enabled|after/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});
