import { Router } from 'express';
import { publicBookingService } from './public-booking.service.js';
import { optionalNumber, optionalString, assertPlainObject } from '../../lib/request-validation.js';
import { attachPublicRequestMeta, createOptionalIdempotencyGuard, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';
import { requireAuth } from '../../middleware/auth.js';

export const publicBookingRouter = Router();

const bookingReadGuard = [
  attachPublicRequestMeta('public-booking-read'),
  createPublicRateLimitGuard({ name: 'public-booking-read', maxRequests: 120, windowMs: 60 * 1000 })
];

const bookingWriteGuard = [
  attachPublicRequestMeta('public-booking-write'),
  createPublicRateLimitGuard({ name: 'public-booking-write', maxRequests: 40, windowMs: 60 * 1000 }),
  createOptionalIdempotencyGuard({ name: 'public-booking-write', windowMs: 15 * 60 * 1000 })
];

publicBookingRouter.get('/bootstrap', bookingReadGuard, async (req, res, next) => {
  try {
    const payload = await publicBookingService.getBootstrap({
      tenantId: optionalString(req.query?.tenantId, { fallback: undefined }),
      tenantSlug: optionalString(req.query?.tenantSlug, { fallback: undefined })
    });
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

publicBookingRouter.get('/vehicle-classes', bookingReadGuard, async (req, res, next) => {
  try {
    const payload = await publicBookingService.getVehicleClasses({
      tenantId: optionalString(req.query?.tenantId, { fallback: undefined }),
      tenantSlug: optionalString(req.query?.tenantSlug, { fallback: undefined }),
      pickupLocationId: optionalString(req.query?.pickupLocationId, { fallback: undefined }),
      pickupAt: optionalString(req.query?.pickupAt, { fallback: undefined }),
      returnAt: optionalString(req.query?.returnAt, { fallback: undefined }),
      limit: optionalNumber(req.query?.limit, 'limit', { integer: true, min: 1, fallback: undefined })
    });
    res.json(payload);
  } catch (error) {
    if (/required|not found|not enabled|after/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/rental-search', bookingWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'booking search payload');
    const payload = await publicBookingService.searchRentalQuotes(req.body || {});
    res.json(payload);
  } catch (error) {
    if (/required|not found|not enabled|after/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/car-sharing-search', bookingWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'car sharing search payload');
    const payload = await publicBookingService.searchCarSharingListings(req.body || {});
    res.json(payload);
  } catch (error) {
    if (/required|not found|not enabled|after/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/checkout', bookingWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'checkout payload');
    const payload = await publicBookingService.createBooking(req.body || {});
    res.status(201).json(payload);
  } catch (error) {
    if (/required|available|sold out|not found|not enabled|after/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/lookup', bookingWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'lookup payload');
    const payload = await publicBookingService.lookupBooking(req.body || {});
    res.json(payload);
  } catch (error) {
    if (/required|not found/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/guest-signin/request', bookingWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'guest sign-in request payload');
    res.json(await publicBookingService.requestGuestSignIn(req.body || {}));
  } catch (error) {
    if (/required|not found/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/guest-signup', bookingWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'guest signup payload');
    res.status(201).json(await publicBookingService.createGuestAccount(req.body || {}));
  } catch (error) {
    if (/required|not found/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/host-signup', bookingWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'host signup payload');
    res.status(201).json(await publicBookingService.createHostSignup(req.body || {}));
  } catch (error) {
    if (/required|not found|enabled|registered|exists|password|vehicle type|photo|insurance|registration|inspection|location|pickup spot/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.get('/guest-signin/:token', bookingReadGuard, async (req, res, next) => {
  try {
    res.json(await publicBookingService.getGuestSession(req.params.token));
  } catch (error) {
    if (/invalid|expired|required|not found/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/guest-signin/verify', bookingWriteGuard, async (req, res, next) => {
  try {
    const token = req.body?.token;
    if (!token) return res.status(400).json({ error: 'Token is required' });
    res.json(await publicBookingService.getGuestSession(String(token)));
  } catch (error) {
    if (/invalid|expired|required|not found/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/issues', bookingWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'issue payload');
    res.status(201).json(await publicBookingService.createIssue(req.body || {}));
  } catch (error) {
    if (/required|not found/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.get('/hosts/:id', bookingReadGuard, async (req, res, next) => {
  try {
    res.json(await publicBookingService.getHostProfile(req.params.id));
  } catch (error) {
    if (/not found/i.test(String(error?.message || ''))) {
      return res.status(404).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.get('/host-reviews/:token', bookingReadGuard, async (req, res, next) => {
  try {
    res.json(await publicBookingService.getHostReviewPrompt(req.params.token));
  } catch (error) {
    if (/invalid|expired|required|submitted/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.post('/host-reviews/:token', bookingWriteGuard, async (req, res, next) => {
  try {
    assertPlainObject(req.body || {}, 'host review payload');
    res.json(await publicBookingService.submitHostReview(req.params.token, req.body || {}));
  } catch (error) {
    if (/invalid|expired|required|submitted|rating/i.test(String(error?.message || ''))) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

publicBookingRouter.get('/host-status', requireAuth, async (req, res, next) => {
  try {
    res.json(await publicBookingService.getHostStatus(req.user));
  } catch (error) {
    if (error?.status === 401) return res.status(401).json({ error: error.message });
    next(error);
  }
});
