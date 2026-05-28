import { Router } from 'express';
import { checkoutSessionService, CheckoutSessionError } from './checkout-session.service.js';
import { vehicleSwapService } from './vehicle-swap.service.js';
import logger from '../../lib/logger.js';

export const checkoutSessionRouter = Router();

function handleError(res, err) {
  if (err instanceof CheckoutSessionError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code || undefined,
    });
  }
  logger.error('[checkout-session] unexpected error', { message: err.message, stack: err.stack });
  return res.status(500).json({ error: 'Internal error' });
}

function getTenantScope(req) {
  // SUPER_ADMIN can pass ?tenantId=...; everyone else is scoped to
  // req.user.tenantId. Same pattern as other routers.
  const role = String(req.user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return req.query.tenantId || req.user?.tenantId || null;
  return req.user?.tenantId || null;
}

// ---------------------------------------------------------------------
// POST /api/checkout-sessions — start a session for a reservation
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/', async (req, res) => {
  try {
    const { reservationId } = req.body || {};
    const tenantId = getTenantScope(req);
    const session = await checkoutSessionService.createForReservation({
      reservationId,
      tenantId,
      actorUserId: req.user?.id,
    });
    res.status(201).json(session);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// GET /api/checkout-sessions/:id — read state (used by polling clients)
// ---------------------------------------------------------------------
checkoutSessionRouter.get('/:id', async (req, res) => {
  try {
    const tenantId = getTenantScope(req);
    const session = await checkoutSessionService.getById(req.params.id, { tenantId });
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json(session);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// GET /api/checkout-sessions/by-reservation/:reservationId
//   convenience for the wizard which opens with reservationId, not id
// ---------------------------------------------------------------------
checkoutSessionRouter.get('/by-reservation/:reservationId', async (req, res) => {
  try {
    const tenantId = getTenantScope(req);
    const session = await checkoutSessionService.getByReservationId(
      req.params.reservationId, { tenantId },
    );
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json(session);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/transition
//   body: { toStep, metadata? }
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/transition', async (req, res) => {
  try {
    const { toStep, metadata } = req.body || {};
    const session = await checkoutSessionService.transition({
      id: req.params.id,
      toStep,
      actorUserId: req.user?.id,
      metadata,
    });
    res.json(session);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/stamp
//   body: { field } — only certain side-effect fields are accepted.
//   Used by internal handlers (T&C-signing public route, Spin webhook,
//   inspection finalize) to mark side-effect completion without doing
//   a transition.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/stamp', async (req, res) => {
  try {
    const { field, value } = req.body || {};
    const session = await checkoutSessionService.stampSideEffect({
      id: req.params.id,
      field,
      value: value ? new Date(value) : null,
    });
    res.json(session);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/terms-token
//   Mint a TERMS_SIGNING QR token (15-min TTL).
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/terms-token', async (req, res) => {
  try {
    const token = await checkoutSessionService.mintHandoffToken({
      sessionId: req.params.id,
      kind: 'TERMS_SIGNING',
      actorUserId: req.user?.id,
    });
    res.status(201).json(token);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/handoff-token
//   Mint a MOBILE_INSPECTION QR token (15-min TTL).
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/handoff-token', async (req, res) => {
  try {
    const token = await checkoutSessionService.mintHandoffToken({
      sessionId: req.params.id,
      kind: 'MOBILE_INSPECTION',
      actorUserId: req.user?.id,
    });
    res.status(201).json(token);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/vehicle
//   Body: { newVehicleId }. Atomic swap of Reservation.vehicleId AND
//   RentalAgreement.vehicleId. Refuses when the session is past
//   INSPECTION_IN_PROGRESS or when the new vehicle is unavailable.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/vehicle', async (req, res) => {
  try {
    const { newVehicleId } = req.body || {};
    const result = await vehicleSwapService.swapVehicle({
      sessionId: req.params.id,
      newVehicleId,
      actorUserId: req.user?.id,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/declined-insurance
//   Body: { declined: boolean }. Persists to RentalAgreement.declinedInsurance
//   so the T&C signing flow + PDF generator know to emit the addendum.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/declined-insurance', async (req, res) => {
  try {
    const { declined } = req.body || {};
    const session = await checkoutSessionService.setDeclinedInsurance({
      id: req.params.id,
      declined: !!declined,
      actorUserId: req.user?.id,
    });
    res.json(session);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/abandon
//   Agent's Save & pause button.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/abandon', async (req, res) => {
  try {
    const { reason } = req.body || {};
    const session = await checkoutSessionService.markAbandoned({
      id: req.params.id,
      reason,
      actorUserId: req.user?.id,
    });
    res.json(session);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// Public route for token exchange — no auth, token IS the auth.
// Mounted separately in main.js under /api/public/checkout-handoff.
// ---------------------------------------------------------------------
export const checkoutSessionPublicRouter = Router();

checkoutSessionPublicRouter.get('/:token', async (req, res) => {
  try {
    const result = await checkoutSessionService.exchangeHandoffToken(req.params.token);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});
