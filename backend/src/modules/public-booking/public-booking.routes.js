import { Router } from 'express';
import { publicBookingService } from './public-booking.service.js';
import { optionalNumber, optionalString, assertPlainObject } from '../../lib/request-validation.js';
import { attachPublicRequestMeta, createOptionalIdempotencyGuard, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';
import { requireAuth } from '../../middleware/auth.js';
import { guestMessagingRouter } from '../messaging/messaging.routes.js';
import { tripChatRouter } from '../messaging/trip-chat.routes.js';
import { aiSearchRouter } from '../ai-search/ai-search.routes.js';

export const publicBookingRouter = Router();

publicBookingRouter.use('/messages', guestMessagingRouter);
publicBookingRouter.use('/trip-chat', tripChatRouter);
publicBookingRouter.use('/ai-search', aiSearchRouter);

const bookingReadGuard = [
  attachPublicRequestMeta('public-booking-read'),
  createPublicRateLimitGuard({ name: 'public-booking-read', maxRequests: 120, windowMs: 60 * 1000 })
];

const bookingWriteGuard = [
  attachPublicRequestMeta('public-booking-write'),
  createPublicRateLimitGuard({ name: 'public-booking-write', maxRequests: 40, windowMs: 60 * 1000 }),
  createOptionalIdempotencyGuard({ name: 'public-booking-write', windowMs: 15 * 60 * 1000 })
];

// Public: get all policies, add-ons, protection tiers for checkout display
publicBookingRouter.get('/policies', bookingReadGuard, async (req, res) => {
  const { getAllPolicies } = await import('../commissions/car-sharing-policies.js');
  const { TRIP_PROTECTION_TIERS, PROTECTION_EXCLUSIONS, OPTIONAL_ADDONS: COMMISSION_ADDONS } = await import('../commissions/car-sharing-commission.js');
  res.json({
    policies: getAllPolicies(),
    protectionTiers: TRIP_PROTECTION_TIERS,
    protectionExclusions: PROTECTION_EXCLUSIONS,
  });
});

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

// ── Rental agreement signature (Sprint 5) ────────────────────────────
// GET resolves the magic-link signature token issued on the admin side
// and returns the agreement metadata + key terms the Flutter guest app
// renders on phone A of design/mockups/sprint5/agreement-and-review.html.
publicBookingRouter.get(
  '/rental-agreements/:token',
  bookingReadGuard,
  async (req, res, next) => {
    try {
      res.json(
        await publicBookingService.getGuestAgreement(req.params.token),
      );
    } catch (error) {
      const msg = String(error?.message || '');
      if (/invalid|expired|not found/i.test(msg)) {
        return res.status(404).json({ error: msg });
      }
      next(error);
    }
  },
);

// POST accepts either a signaturePng (data URL from the Flutter canvas)
// or a typedName (VoiceOver/TalkBack accessibility fallback). Once one
// is supplied the token is single-use — a second POST returns 409.
publicBookingRouter.post(
  '/rental-agreements/:token/signature',
  bookingWriteGuard,
  async (req, res, next) => {
    try {
      assertPlainObject(req.body || {}, 'signature payload');
      res.json(
        await publicBookingService.submitGuestSignature(
          req.params.token,
          req.body || {},
        ),
      );
    } catch (error) {
      const msg = String(error?.message || '');
      if (/invalid|expired|not found/i.test(msg)) {
        return res.status(404).json({ error: msg });
      }
      if (/already signed/i.test(msg)) {
        return res.status(409).json({ error: msg });
      }
      if (/required|invalid|too large|unsupported/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      next(error);
    }
  },
);

// ── Pre-check-in documents (Sprint 4) ────────────────────────────────
// GET returns the current document submission state for the trip. The
// Flutter app hits this on the pre-check-in overview screen so
// returning guests don't re-capture docs they already submitted.
publicBookingRouter.get(
  '/trips/:tripCode/documents',
  bookingReadGuard,
  async (req, res, next) => {
    try {
      res.json(
        await publicBookingService.getTripDocuments(req.params.tripCode),
      );
    } catch (error) {
      if (/not found/i.test(String(error?.message || ''))) {
        return res.status(404).json({ error: error.message });
      }
      next(error);
    }
  },
);

// POST uploads up to 3 document types (license, insurance, addressProof)
// as base64 data URLs. Idempotent per-type — a re-submit replaces the
// prior row while host review is still pending. Returns the full
// up-to-date list of documents so the client renders the success state
// without a follow-up GET.
publicBookingRouter.post(
  '/trips/:tripCode/documents',
  bookingWriteGuard,
  async (req, res, next) => {
    try {
      assertPlainObject(req.body || {}, 'documents payload');
      res.json(
        await publicBookingService.submitTripDocuments(
          req.params.tripCode,
          req.body || {},
        ),
      );
    } catch (error) {
      const msg = String(error?.message || '');
      if (/not found/i.test(msg)) {
        return res.status(404).json({ error: msg });
      }
      if (/required|invalid|too large|unsupported|already/i.test(msg)) {
        return res.status(400).json({ error: msg });
      }
      next(error);
    }
  },
);
