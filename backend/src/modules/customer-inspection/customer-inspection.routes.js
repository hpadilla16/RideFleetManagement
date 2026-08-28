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
import { crossTenantScopeFor as scopeFor } from '../../lib/tenant-scope.js';
import { createPublicRateLimitGuard, attachPublicRequestMeta } from '../../middleware/public-endpoint-guards.js';
import logger from '../../lib/logger.js';

export const customerInspectionPublicRouter = Router();

// Damage photos arrive as data URLs (~300KB-2MB) — bump this router's body
// limit only, like the mobile-inspection router does.
customerInspectionPublicRouter.use(express.json({ limit: '15mb' }));

// Per-IP rate limiting (2026-08-22). This router is unauthenticated — the token
// (or the printed QR) is the only credential — so without a guard it had no
// brute-force or abuse ceiling at all. Mirrors terms-signing's tiers: a tight
// cap on the QR resolve (it mints a token) and the write, looser on reads.
// attachPublicRequestMeta is a FACTORY — it must be CALLED with a name to get
// the middleware. Passing the factory itself to .use() made Express run it as
// (req,res,next), which never calls next() and hung every route on this router
// (hotfix 2026-08-22).
customerInspectionPublicRouter.use(attachPublicRequestMeta('customer-inspection'));
const qrResolveLimit = createPublicRateLimitGuard({ name: 'customer-inspection-qr', maxRequests: 10, windowMs: 60 * 1000 });
const readLimit = createPublicRateLimitGuard({ name: 'customer-inspection-read', maxRequests: 60, windowMs: 60 * 1000 });
const writeLimit = createPublicRateLimitGuard({ name: 'customer-inspection-write', maxRequests: 30, windowMs: 60 * 1000 });

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

// GET /api/customer-inspection/v/:payload — resolve a scanned printed per-vehicle QR
// (payload = "vehicleId.sig") to a CHECK-IN inspection token for the active rental.
// Defined BEFORE /:token so the two-segment static route wins.
customerInspectionPublicRouter.get('/v/:payload', qrResolveLimit, async (req, res) => {
  try {
    res.json(await customerInspectionService.startCheckinByVehicleQr({ payload: req.params.payload }));
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/customer-inspection/r/:payload — resolve a scanned RESERVATION-bound QR
// (payload = "reservationId.expMs.sig", printed on the rental agreement) to a
// CHECK-IN inspection token for that reservation. Signed + expiring; supersedes
// the static per-vehicle sticker as the primary QR. Defined BEFORE /:token so the
// two-segment static route wins.
customerInspectionPublicRouter.get('/r/:payload', qrResolveLimit, async (req, res) => {
  try {
    res.json(await customerInspectionService.startInspectionByReservationQr({ payload: req.params.payload }));
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/customer-inspection/:token — step 1 context (identity + vehicle +
// diagram type + views).
customerInspectionPublicRouter.get('/:token', readLimit, async (req, res) => {
  try {
    res.json(await customerInspectionService.loadByToken(req.params.token));
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/customer-inspection/:token/damage
// body: { view, xPct, yPct, description?, photoDataUrl }
customerInspectionPublicRouter.post('/:token/damage', writeLimit, async (req, res) => {
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

// ---------------------------------------------------------------------------
// Fase B — AUTHED review queue (mounted at /api/customer-inspections with
// requireAuth in main.js). Tenant-scoped via scopeFor.
// ---------------------------------------------------------------------------

export const customerInspectionRouter = Router();

// Fase C — vehicle damage history (defined BEFORE /:id so the static
// segment wins). GET /api/customer-inspections/vehicle/:vehicleId
customerInspectionRouter.get('/vehicle/:vehicleId', async (req, res) => {
  try {
    res.json(await customerInspectionService.getVehicleDamageHistory(req.params.vehicleId, scopeFor(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/customer-inspections/vehicle/:vehicleId/manual-damage — agent records an EXISTING
// damage from the vehicle profile (diagram dot + photo). body: { view, xPct, yPct, description?, photoDataUrl }
customerInspectionRouter.post('/vehicle/:vehicleId/manual-damage', express.json({ limit: '15mb' }), async (req, res) => {
  try {
    res.json(await customerInspectionService.addManualDamage(req.params.vehicleId, req.body || {}, scopeFor(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/customer-inspections/vehicle/:vehicleId/checkin-qr — the printable per-vehicle QR URL
// (agent prints it and places it inside the car as a check-in fail-safe).
customerInspectionRouter.get('/vehicle/:vehicleId/checkin-qr', async (req, res) => {
  try {
    res.json({ url: customerInspectionService.checkinQrUrlForVehicle(req.params.vehicleId) });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/customer-inspections/checkin/:reservationId — manually send (or resend with ?force=1)
// the CHECK-IN (return) inspection link. The D-1 scheduler calls the service directly.
customerInspectionRouter.post('/checkin/:reservationId', async (req, res) => {
  try {
    const force = String(req.query?.force || '') === '1' || req.body?.force === true;
    res.json(await customerInspectionService.sendCheckinInspection({
      reservationId: req.params.reservationId,
      actorUserId: req.user?.id || req.user?.sub || null,
      force,
    }));
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/customer-inspections/reports/:reportId/fix — body: { photoDataUrl }
customerInspectionRouter.post('/reports/:reportId/fix', express.json({ limit: '15mb' }), async (req, res) => {
  try {
    res.json(await customerInspectionService.fixDamageReport({
      reportId: req.params.reportId,
      photoDataUrl: req.body?.photoDataUrl,
      actorUserId: req.user?.id || req.user?.sub || null,
      scope: scopeFor(req),
    }));
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/customer-inspections?status=SUBMITTED | ?reservationId=...
customerInspectionRouter.get('/', async (req, res) => {
  try {
    res.json(await customerInspectionService.listInspections(scopeFor(req), {
      status: req.query?.status ? String(req.query.status) : undefined,
      reservationId: req.query?.reservationId ? String(req.query.reservationId) : undefined,
    }));
  } catch (err) {
    handleError(res, err);
  }
});

// GET /api/customer-inspections/:id — detail with damage reports + photo URLs.
customerInspectionRouter.get('/:id', async (req, res) => {
  try {
    res.json(await customerInspectionService.getInspection(req.params.id, scopeFor(req)));
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/customer-inspections/:id/reports/:reportId/review
// body: { action: 'soft' | 'hard' }
customerInspectionRouter.post('/:id/reports/:reportId/review', async (req, res) => {
  try {
    res.json(await customerInspectionService.reviewReport({
      inspectionId: req.params.id,
      reportId: req.params.reportId,
      action: req.body?.action,
      actorUserId: req.user?.id || req.user?.sub || null,
      scope: scopeFor(req),
    }));
  } catch (err) {
    handleError(res, err);
  }
});
