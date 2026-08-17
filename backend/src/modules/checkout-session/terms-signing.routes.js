/**
 * Public token-scoped signing routes for the customer's phone.
 *
 * Mounted at /api/sign in main.js. NO auth middleware — the token IS
 * the auth. Token validity (kind=TERMS_SIGNING, not expired, not
 * consumed) is verified inside termsSigningService on every call.
 */

import { Router } from 'express';
import { termsSigningService } from './terms-signing.service.js';
import { CheckoutSessionError } from './checkout-session.service.js';
import logger from '../../lib/logger.js';
import {
  attachPublicRequestMeta,
  createPublicRateLimitGuard,
} from '../../middleware/public-endpoint-guards.js';

export const termsSigningPublicRouter = Router();

// Per-IP guards, the same pair every other public token router carries
// (addendum-signature-public.routes.js:27-34, and portal/loaner/kiosk/
// store-board/issues/shuttle-tracker/booking). /api/sign was the only one
// mounted bare: uncapped reads let a token be probed for existence, and the
// POSTs take base64 images with no ceiling at all.
//
// WRITE CAP — sized off the worst LEGITIMATE minute, not off a round number.
// A signing session posts one initial per section and one final signature. The
// most sections a customer can ever be shown is 8 (TC_SECTIONS' 6, plus
// declined_insurance and damage_acknowledgement — see terms-content.js), and a
// customer correcting sloppy initials re-posts the same section: the pad fires
// on every finger-lift. 8 sections × 5 attempts + completes ≈ 45, so 45/min
// leaves a renter who redoes EVERY section five times inside one minute
// untouched, while still capping an attacker at ~45 images/min/IP. It also
// absorbs two or three customers signing at once from the counter's guest
// wi-fi, which shares one public IP — a real signing spans minutes, so their
// posts do not stack inside a single window.
const signRead = [
  attachPublicRequestMeta('terms-signing-read'),
  createPublicRateLimitGuard({ name: 'terms-signing-read', maxRequests: 60, windowMs: 60 * 1000 }),
];
const signWrite = [
  attachPublicRequestMeta('terms-signing-write'),
  createPublicRateLimitGuard({ name: 'terms-signing-write', maxRequests: 45, windowMs: 60 * 1000 }),
];

function handleError(res, err) {
  if (err instanceof CheckoutSessionError) {
    return res.status(err.status).json({ error: err.message, code: err.code || undefined });
  }
  logger.error('[terms-signing] unexpected', { message: err.message });
  return res.status(500).json({ error: 'Internal error' });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim();
}

// GET /api/sign/:token — returns the session payload (sections + signed state).
termsSigningPublicRouter.get('/:token', signRead, async (req, res) => {
  try {
    const data = await termsSigningService.loadSession(req.params.token);
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/sign/:token/initials — body { sectionKey, initialDataUrl }
termsSigningPublicRouter.post('/:token/initials', signWrite, async (req, res) => {
  try {
    const { sectionKey, initialDataUrl } = req.body || {};
    const result = await termsSigningService.saveInitial({
      token: req.params.token,
      sectionKey,
      initialDataUrl,
      customerIp: clientIp(req),
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/sign/:token/complete — body { signatureDataUrl, signerName }
termsSigningPublicRouter.post('/:token/complete', signWrite, async (req, res) => {
  try {
    const { signatureDataUrl, signerName } = req.body || {};
    const result = await termsSigningService.complete({
      token: req.params.token,
      signatureDataUrl,
      signerName,
      customerIp: clientIp(req),
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});
