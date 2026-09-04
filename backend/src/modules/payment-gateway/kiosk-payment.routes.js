/**
 * The kiosk's payment routes, mounted on /api/kiosk — NOT on the authenticated
 * /api/payment-gateway router.
 *
 * They live in this module because payment-references.test.mjs R2 forbids any
 * kiosk module file from importing a gateway client, so the live-payment guards
 * cannot be reached past. But they must be REACHABLE where the kiosk calls them
 * and behind the kiosk's own device-token middleware.
 *
 * Getting that wrong is not merely a dead endpoint: kioskFetch treats a 401
 * without a known code as a dead device token and calls clearDevice(), so a
 * misrouted payment button UNPAIRS the tablet in front of a guest mid-check-in.
 * QA caught exactly that (B1). deviceGuards must be the first thing that runs.
 */
import express from 'express';
import { deviceGuards } from '../kiosk/kiosk.routes.js';
import { attachPublicRequestMeta, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';
import { kioskPaymentLinkService } from './kiosk-payment-link.service.js';

export const kioskPaymentRouter = express.Router();

const send = (handler) => async (req, res, next) => {
  try {
    res.json(await handler(req));
  } catch (err) {
    // A coded gateway error (GATEWAY_NOT_CONFIGURED, ALREADY_PAID…) carries a
    // `code` but no HTTP status, so it used to surface as a 500 — "the system
    // broke" instead of "this tenant has no gateway set up". Map the ones that
    // are configuration or state, not faults. (QA NIT.)
    const CODE_STATUS = {
      GATEWAY_NOT_CONFIGURED: 409, ALREADY_PAID: 409, VALIDATION: 400, AMOUNT_MISMATCH: 409,
      UNKNOWN_REFERENCE: 404, PAYMENT_NOT_COMPLETED: 409, GATEWAY_ERROR: 502,
    };
    if (!err?.status && err?.code && CODE_STATUS[err.code]) {
      res.status(CODE_STATUS[err.code]).json({ error: err.message, code: err.code });
      return;
    }
    if (err?.status) {
      // Always carry the code: kioskFetch decides whether a failure means "the
      // device is dead" from the code, and a bare 401 makes it wipe the pairing.
      res.status(err.status).json({ error: err.message, code: err.code || 'KIOSK_PAYMENT_ERROR' });
      return;
    }
    next(err);
  }
};

// POST /api/kiosk/sessions/:id/payment-link
kioskPaymentRouter.post('/sessions/:id/payment-link', deviceGuards, send(
  (req) => kioskPaymentLinkService.createPaymentLink(req.params.id, req.kioskDevice),
));

// GET /api/kiosk/payment-return?ref= — the guest's phone lands here after paying.
// No device token: this is the GUEST's browser, not the tablet. The reference is
// the only thing it carries and nothing is trusted from it — the amount and the
// approval are re-read from the gateway before anything is recorded.
// Unauthenticated by nature — it is the GUEST's phone, not the tablet — so it
// gets the same public guards every other unauthenticated route in this repo
// carries. Each hit costs queries and, if it resolves, an outbound gateway call.
const returnGuards = [
  attachPublicRequestMeta('kiosk-payment-return'),
  createPublicRateLimitGuard({ name: 'kiosk-payment-return', maxRequests: 30, windowMs: 60 * 1000 }),
];
kioskPaymentRouter.get('/payment-return', returnGuards, send(
  (req) => kioskPaymentLinkService.handlePaymentReturn(req.query?.ref),
));
