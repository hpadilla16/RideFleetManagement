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

export const termsSigningPublicRouter = Router();

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
termsSigningPublicRouter.get('/:token', async (req, res) => {
  try {
    const data = await termsSigningService.loadSession(req.params.token);
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/sign/:token/initials — body { sectionKey, initialDataUrl }
termsSigningPublicRouter.post('/:token/initials', async (req, res) => {
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
termsSigningPublicRouter.post('/:token/complete', async (req, res) => {
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
