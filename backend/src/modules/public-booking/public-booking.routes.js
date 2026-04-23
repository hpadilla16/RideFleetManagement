import { Router } from 'express';
import { publicBookingService } from './public-booking.service.js';
import { createGuestPaymentSession, renderReturnPage } from './payment-session.service.js';
import {
  confirmPayArcCharge,
  preparePayArcBridge,
  handlePayArcWebhook,
} from './payarc-session.service.js';
import { renderPayArcBridge } from './payarc-bridge-html.js';
import { PAYARC_JS_URL } from './payarc-hosted-fields.js';
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

// Sprint 6 — Flutter payment WebView.
//
// POST /api/public/booking/trips/:tripCode/payment-session
// Returns a gateway-agnostic shape so the Flutter client never knows
// (or cares) whether Authorize.Net, Stripe, or SPIn is doing the
// work. See payment-session.service.js for the phased rollout strategy
// — today `gateway: 'authorizenet'` with Accept Hosted; later we flip
// the internal branch to SPIn with zero Flutter release.
//
// Payment posting is webhook-driven (customer-portal's authnet webhook),
// so there's no PUT/confirm endpoint here — the Flutter client simply
// closes the WebView when it sees `successMatchUrl` in the navigation
// stream and polls the trip for the PAID flip.
publicBookingRouter.post(
  '/trips/:tripCode/payment-session',
  bookingWriteGuard,
  async (req, res, next) => {
    try {
      const session = await createGuestPaymentSession({
        tripCode: req.params.tripCode,
        tenantId: optionalString(req.query?.tenantId, { fallback: null }),
      });
      res.json(session);
    } catch (error) {
      const code = error?.code;
      if (code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
      if (code === 'ALREADY_PAID') return res.status(409).json({ error: error.message });
      if (code === 'NOT_PAYABLE') return res.status(409).json({ error: error.message });
      if (code === 'VALIDATION') return res.status(400).json({ error: error.message });
      if (code === 'GATEWAY_NOT_CONFIGURED') {
        return res.status(503).json({ error: error.message });
      }
      if (code === 'GATEWAY_ERROR') {
        return res.status(502).json({ error: error.message });
      }
      next(error);
    }
  },
);

// GET .../payment-return and .../payment-cancel — the Flutter WebView
// watches for these URLs in its navigation stream and closes before
// the page actually loads. If a user ever lands here from a browser
// (e.g. tapped an email receipt link), we serve a tiny "you can close
// this page" HTML response. No DB writes here — the silent webhook is
// the source of truth for reservation.paymentStatus.
publicBookingRouter.get(
  '/trips/:tripCode/payment-return',
  bookingReadGuard,
  (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderReturnPage({ status: 'success' }));
  },
);

publicBookingRouter.get(
  '/trips/:tripCode/payment-cancel',
  bookingReadGuard,
  (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderReturnPage({ status: 'cancel' }));
  },
);

// ── PayArc WebView bridge (US-mainland pickups only) ─────────────
//
// GET /payarc-bridge?s=<signed-nonce>
//   Serves a minimal HTML page that embeds payarc.js Hosted Fields.
//   The Flutter WebView loads this in place of a gateway-hosted URL.
//
// POST /payarc-charge
//   Body: { nonce, tokenId }. The bridge HTML POSTs here after
//   tokenizing the card. On success the inline JS redirects the
//   WebView to the successMatchUrl returned by payment-session.
publicBookingRouter.get(
  '/trips/:tripCode/payarc-bridge',
  bookingReadGuard,
  async (req, res, next) => {
    try {
      const data = await preparePayArcBridge({
        tripCode: req.params.tripCode,
        nonce: String(req.query?.s || ''),
      });
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(
        renderPayArcBridge({
          ...data,
          payarcJsUrl: data.payarcJsUrl || PAYARC_JS_URL,
        }),
      );
    } catch (error) {
      const code = error?.code;
      if (code === 'NOT_FOUND') return res.status(404).send('Not found');
      if (code === 'INVALID_NONCE') {
        return res.status(400).send('Invalid or expired payment link');
      }
      if (code === 'GATEWAY_NOT_CONFIGURED') {
        return res.status(503).send('Secure payment temporarily unavailable');
      }
      next(error);
    }
  },
);

publicBookingRouter.post(
  '/trips/:tripCode/payarc-charge',
  bookingWriteGuard,
  async (req, res, next) => {
    try {
      assertPlainObject(req.body || {}, 'charge payload');
      const result = await confirmPayArcCharge({
        tripCode: req.params.tripCode,
        body: req.body || {},
      });
      res.json(result);
    } catch (error) {
      const code = error?.code;
      if (code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
      if (code === 'INVALID_NONCE') return res.status(400).json({ error: error.message });
      if (code === 'VALIDATION') return res.status(400).json({ error: error.message });
      if (code === 'CARD_DECLINED' || code === 'CARD_EXPIRED' || code === 'CARD_INVALID_CVC') {
        return res.status(402).json({ error: error.message, code });
      }
      if (code === 'GATEWAY_NOT_CONFIGURED') {
        return res.status(503).json({ error: error.message });
      }
      if (code === 'GATEWAY_ERROR') {
        return res.status(502).json({ error: error.message });
      }
      next(error);
    }
  },
);

// ── PayArc webhook ───────────────────────────────────────────────
// Mounted at /api/public/payment-gateway/payarc/webhook by the
// parent public router. The signature verification reads raw body,
// so we rely on express.json() having preserved it. Returns 200 for
// ignored events (so PayArc doesn't retry).
//
// NOTE: this route lives on the generic public-booking router for
// co-location with the session service; it will be mounted at
// `/api/public/booking/payment-gateway/payarc/webhook` via the
// express parent. If PayArc expects the exact URL
// `/api/public/payment-gateway/payarc/webhook` (mirroring the
// existing Authorize.Net endpoint), we can add a short alias in the
// main routes file — trivial to move once Hector registers the URL
// in the PayArc dashboard.
publicBookingRouter.post(
  '/payment-gateway/payarc/webhook',
  async (req, res) => {
    try {
      const rawBody =
        typeof req.rawBody === 'string' || Buffer.isBuffer(req.rawBody)
          ? req.rawBody
          : JSON.stringify(req.body || {});
      const result = await handlePayArcWebhook({
        rawBody,
        headers: req.headers || {},
        body: req.body || {},
      });
      res.json(result);
    } catch (error) {
      if (error?.code === 'UNAUTHORIZED') {
        return res.status(401).json({ error: 'Invalid signature' });
      }
      // Always 200 on parse/match failures — PayArc retries on 5xx
      // and we don't want to thrash if the payload just isn't ours.
      res.json({ ok: true, ignored: true, reason: error?.message || 'unhandled' });
    }
  },
);
