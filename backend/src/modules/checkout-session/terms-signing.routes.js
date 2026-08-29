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
// INITIALS CAP — sized off the worst LEGITIMATE minute, not off a round number.
// A signing session posts one initial per section. The most sections a
// customer can ever be shown is SEVEN: TC_SECTIONS' 6, plus declined_insurance
// when they waived counter coverage. (damage_acknowledgement is NOT one of
// them — terms-content.js is explicit that it belongs to the Report Damage
// wizard and never reaches AgreementSectionInitial.) A customer correcting
// sloppy initials re-posts the same section, and saveInitial upserts on
// (agreementId, sectionKey), so the retry overwrites rather than erroring.
//
// The pad used to fire on every finger-lift, which put a four-stroke "H.P."
// at four POSTs — and, worse, locked itself after the first one. Since
// 2026-08-26 it debounces to ONE post per settled initial (SignClient.jsx,
// INITIAL_COMMIT_DELAY_MS), so real traffic here is a fraction of what the
// numbers below were sized for. They stay as they are: the cap only ever had
// to be generous enough never to catch a legitimate renter, and it now is by
// a wider margin than when it was written.
//
// 7 × 5 attempts = 35, so 45/min leaves a renter who redoes EVERY
// section five times inside one minute untouched, and still absorbs two or
// three customers signing at once from the counter's guest wi-fi, which shares
// one public IP — a real signing spans minutes, so their posts do not stack
// inside one window.
//
// COMPLETE gets its own, much smaller bucket. It used to share the initials
// budget, which meant an over-eager initialer could be locked out of
// SUBMITTING the signature they had just finished drawing — a new way to block
// a signature on a route that previously had no cap at all. One submission is
// the norm; 10/min is retries after a transient failure, nothing more.
//
// WHAT THIS ACTUALLY CAPS IN PRODUCTION. The buckets are a module-level Map
// (public-endpoint-guards.js), and prod runs start:cluster
// (backend/Dockerfile.prod's CMD) with CLUSTER_WORKERS=4, set in
// docker-compose.prod.yml:28 — and 4 is also where cluster.js:4 lands by
// default, so the number holds either way. Each worker counts separately. An
// attacker opening parallel connections spreads across all four and reaches
// ~4× these numbers; the legitimate customer, pinned to one worker by
// keep-alive, sees exactly the number written here. The asymmetry runs the
// wrong way and it predates this router — but do not read "45/min" as a
// system-wide ceiling. A shared store (the Redis the tenant limiter already
// uses) is what would make it one.
const signRead = [
  attachPublicRequestMeta('terms-signing-read'),
  createPublicRateLimitGuard({ name: 'terms-signing-read', maxRequests: 60, windowMs: 60 * 1000 }),
];
const signWrite = [
  attachPublicRequestMeta('terms-signing-write'),
  createPublicRateLimitGuard({ name: 'terms-signing-write', maxRequests: 45, windowMs: 60 * 1000 }),
];
const signComplete = [
  attachPublicRequestMeta('terms-signing-complete'),
  createPublicRateLimitGuard({ name: 'terms-signing-complete', maxRequests: 10, windowMs: 60 * 1000 }),
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
termsSigningPublicRouter.post('/:token/complete', signComplete, async (req, res) => {
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
