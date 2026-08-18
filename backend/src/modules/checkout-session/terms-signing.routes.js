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
import { attachPublicRequestMeta, createPublicRateLimitGuard } from '../../middleware/public-endpoint-guards.js';
import logger from '../../lib/logger.js';

export const termsSigningPublicRouter = Router();

// Per-IP guards for the same trust model the customer portal uses. The token
// is 192 bits so brute force is infeasible, but without a throttle a caller
// could repeat the request cost indefinitely against an invalid token.
//
// The two write endpoints get SEPARATE ceilings because they have opposite
// cost profiles, and a single shared bucket has to be wrong for one of them:
//
//   /:token/initials  ~35 calls per session, decodes NOTHING. The pad calls
//                     back on every pen-up (frontend/src/app/sign/[token]/
//                     page.js onInitialChange), so one customer posts an
//                     initial per STROKE across up to 8 sections.
//   /:token/complete  exactly ONE call per session, and the only one that
//                     decodes a PNG.
//
// So `initials` needs headroom and `complete` must stay tight. The portal's
// 30/min was sized for a flow that posts once; applying it to `initials` would
// 429 a customer mid-signature, and the /sign page treats an error as fatal —
// it unmounts the flow and the drawn signature is lost. Blocking a real
// customer from signing is worse than the flood this guard exists to cap.
// The bucket is keyed by IP and this is a scan-the-QR-on-your-phone flow, so
// carrier CGNAT and branch guest WiFi put several customers behind one address.
//
// Conversely `complete` must NOT inherit that headroom. Its decode is bounded
// but not cheap: a hostile-but-legal geometry near MAX_RAW_BYTES costs ~180ms,
// and complete rejects a blank signature BEFORE the transaction that consumes
// the token, so one valid link replays indefinitely. At 20/min that is ~3.5s
// of event loop per minute per IP; at 240 it would be most of the minute.
// A customer completes once, so 20 leaves ample room for reload retries.
//
// Keyed by IP, not by token: a token-keyed bucket would hand an attacker free
// evasion, since rotating the token in the URL would mint a fresh bucket.
export const SIGN_READ_MAX_PER_MIN = 300;
export const SIGN_INITIALS_MAX_PER_MIN = 240;
export const SIGN_COMPLETE_MAX_PER_MIN = 20;

const signRead = [
  attachPublicRequestMeta('terms-signing-read'),
  createPublicRateLimitGuard({ name: 'terms-signing-read', maxRequests: SIGN_READ_MAX_PER_MIN, windowMs: 60 * 1000 })
];
const signInitials = [
  attachPublicRequestMeta('terms-signing-initials'),
  createPublicRateLimitGuard({ name: 'terms-signing-initials', maxRequests: SIGN_INITIALS_MAX_PER_MIN, windowMs: 60 * 1000 })
];
const signComplete = [
  attachPublicRequestMeta('terms-signing-complete'),
  createPublicRateLimitGuard({ name: 'terms-signing-complete', maxRequests: SIGN_COMPLETE_MAX_PER_MIN, windowMs: 60 * 1000 })
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
termsSigningPublicRouter.post('/:token/initials', signInitials, async (req, res) => {
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
