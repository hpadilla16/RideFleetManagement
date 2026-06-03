/**
 * Public token-scoped mobile-inspection routes for the agent's phone.
 *
 * Mounted at /api/mobile-inspection in main.js. NO auth middleware —
 * the token IS the auth. Token validity (kind=MOBILE_INSPECTION, not
 * expired, not consumed) is verified inside mobileInspectionService on
 * every call.
 */

import { Router } from 'express';
import { mobileInspectionService } from './mobile-inspection.service.js';
import { CheckoutSessionError } from './checkout-session.service.js';
import logger from '../../lib/logger.js';

export const mobileInspectionPublicRouter = Router();

// Image data URLs can run ~300KB-2MB per photo; bump the body limit on
// just this router so the global 100KB JSON parser doesn't reject the
// upload. Set on the router itself so other public endpoints stay tight.
import express from 'express';
mobileInspectionPublicRouter.use(express.json({ limit: '15mb' }));

function handleError(res, err) {
  if (err instanceof CheckoutSessionError) {
    return res.status(err.status).json({ error: err.message, code: err.code || undefined });
  }
  logger.error('[mobile-inspection] unexpected', { message: err.message });
  return res.status(500).json({ error: 'Internal error' });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim();
}

// GET /api/mobile-inspection/:token — returns the inspection state
// (angles + which ones are already captured).
mobileInspectionPublicRouter.get('/:token', async (req, res) => {
  try {
    const data = await mobileInspectionService.loadSession(req.params.token);
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/mobile-inspection/:token/photo
// body: { angleKey, photoDataUrl, notes? }
mobileInspectionPublicRouter.post('/:token/photo', async (req, res) => {
  try {
    const { angleKey, photoDataUrl, notes } = req.body || {};
    const result = await mobileInspectionService.savePhoto({
      token: req.params.token,
      angleKey,
      photoDataUrl,
      notes,
      customerIp: clientIp(req),
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/mobile-inspection/:token/complete
// body: { signatureDataUrl?, signerName?, odometer?, fuelLevel?, notes? }
mobileInspectionPublicRouter.post('/:token/complete', async (req, res) => {
  try {
    const { signatureDataUrl, signerName, odometer, fuelLevel, notes } = req.body || {};
    const result = await mobileInspectionService.complete({
      token: req.params.token,
      signatureDataUrl,
      signerName,
      odometer,
      fuelLevel,
      notes,
      customerIp: clientIp(req),
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});
