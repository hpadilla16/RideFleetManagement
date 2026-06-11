/**
 * Public token-scoped routes for the CUSTOMER-led inspection (2026-06-11).
 * Mounted at /api/customer-inspection in main.js. NO auth middleware — the
 * 24h CUSTOMER_INSPECTION token IS the auth (same model as mobile-inspection
 * and terms-signing). Token validity is re-verified inside the service on
 * every call.
 */

import { Router } from 'express';
import express from 'express';
import { customerInspectionService } from './customer-inspection.service.js';
import { CheckoutSessionError } from '../checkout-session/checkout-session.service.js';
import logger from '../../lib/logger.js';

export const customerInspectionPublicRouter = Router();

// Damage photos arrive as data URLs (~300KB-2MB) — bump this router's body
// limit only, like the mobile-inspection router does.
customerInspectionPublicRouter.use(express.json({ limit: '15mb' }));

function handleError(res, err) {
  if (err instanceof CheckoutSessionError) {
    return res.status(err.status).json({ error: err.message, code: err.code || undefined });
  }
  logger.error('[customer-inspection] unexpected', { message: err.message });
  return res.status(500).json({ error: 'Internal error' });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim();
}

// GET /api/customer-inspection/:token — step 1 context (identity + vehicle +
// diagram type + views).
customerInspectionPublicRouter.get('/:token', async (req, res) => {
  try {
    res.json(await customerInspectionService.loadByToken(req.params.token));
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/customer-inspection/:token/damage
// body: { view, xPct, yPct, description?, photoDataUrl }
customerInspectionPublicRouter.post('/:token/damage', async (req, res) => {
  try {
    const { view, xPct, yPct, description, photoDataUrl } = req.body || {};
    res.json(await customerInspectionService.reportDamage({
      token: req.params.token,
      view, xPct, yPct, description, photoDataUrl,
      customerIp: clientIp(req),
    }));
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/customer-inspection/:token/complete — finish (0+ reports OK).
customerInspectionPublicRouter.post('/:token/complete', async (req, res) => {
  try {
    res.json(await customerInspectionService.completeInspection({ token: req.params.token }));
  } catch (err) {
    handleError(res, err);
  }
});
