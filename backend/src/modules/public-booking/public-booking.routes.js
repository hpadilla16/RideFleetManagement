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

publicBookingRouter.post('/checkout', async (req, res, next) => {
  try {
    const payload = await publicBookingService.createBooking(req.body || {});
    res.status(201).json(payload);
  } catch (error) {
    if (/required|available|sold out|not found|not enabled|after/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/lookup', async (req, res, next) => {
  try {
    const payload = await publicBookingService.lookupBooking(req.body || {});
    res.json(payload);
  } catch (error) {
    if (/required|not found/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/issues', async (req, res, next) => {
  try {
    res.status(201).json(await publicBookingService.createIssue(req.body || {}));
  } catch (error) {
    if (/required|not found/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.get('/hosts/:id', async (req, res, next) => {
  try {
    res.json(await publicBookingService.getHostProfile(req.params.id));
  } catch (error) {
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.get('/host-reviews/:token', async (req, res, next) => {
  try {
    res.json(await publicBookingService.getHostReviewPrompt(req.params.token));
  } catch (error) {
    if (/invalid|expired|required|submitted/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/host-reviews/:token', async (req, res, next) => {
  try {
    res.json(await publicBookingService.submitHostReview(req.params.token, req.body || {}));
  } catch (error) {
    if (/invalid|expired|required|submitted|rating/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});
