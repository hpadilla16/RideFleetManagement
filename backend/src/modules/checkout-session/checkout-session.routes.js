import { Router } from 'express';
import { checkoutSessionService, CheckoutSessionError } from './checkout-session.service.js';
import { checkoutPresenceService } from './checkout-presence.service.js';
import { vehicleSwapService } from './vehicle-swap.service.js';
import { spinChargeService } from './spin-charge.service.js';
import { spinClient } from '../payment-gateway/spin-client.js';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

export const checkoutSessionRouter = Router();

function handleError(res, err) {
  if (err instanceof CheckoutSessionError) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code || undefined,
      // M2 P2 (2026-08-17): STALE_VERSION carries the fresh row so the stale
      // surface re-renders without a follow-up GET. Absent on every other
      // error — additive, existing clients never see the field.
      ...(err.session ? { session: err.session } : {}),
      // 2026-08-17: FINALIZE_INCOMPLETE folds several distinct guard failures
      // (VEHICLE_CONFLICT, NO_VEHICLE_ASSIGNED, PRECHECKIN_REQUIRED,
      // AGE_RULES_*) into one code, because they leave one indistinguishable
      // state: closed session, unfinalized rental. `reason` hands the caller
      // the guard that actually fired, so RideOps can route the agent to the
      // right fix without parsing the message. Same additive contract as
      // `session` above.
      ...(err.reason ? { reason: err.reason } : {}),
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
    // M2 P1: presence attached by the serializer — the row is untouched and
    // the field is additive (older clients ignore it). Never blocks the read.
    res.json(await checkoutPresenceService.withPresence(session));
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
      req.params.reservationId,
      { tenantId, actorUserId: req.user?.id || req.user?.sub || null },
    );
    if (!session) return res.status(404).json({ error: 'Not found' });
    // M2 P1: same additive presence serializer as GET /:id.
    res.json(await checkoutPresenceService.withPresence(session));
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
    // expectedVersion (M2 P2, 2026-08-17): OPTIONAL optimistic guard — when
    // present and stale the service throws 409 STALE_VERSION with the fresh
    // row. Omitted (all pre-M2 clients) → behavior unchanged.
    const { toStep, metadata, expectedVersion } = req.body || {};
    const session = await checkoutSessionService.transition({
      id: req.params.id,
      toStep,
      actorUserId: req.user?.id,
      metadata,
      expectedVersion,
    });
    res.json(session);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/presence
//   M2 P1 (2026-08-17) — soft presence heartbeat. Body: { surface, label? }.
//   Surfaces poll this alongside GET /:id; the GETs then expose
//   presence: [{surface, displayName, lastSeenAt}] filtered by the 45 s
//   logical TTL. Informative ONLY — never gates anything (M2-PLAN §1.2).
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/presence', async (req, res) => {
  try {
    const { surface, label } = req.body || {};
    const tenantId = getTenantScope(req);
    const out = await checkoutPresenceService.heartbeat({
      sessionId: req.params.id,
      surface,
      label,
      actorUserId: req.user?.id || null,
      tenantId,
    });
    res.json(out);
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
    const { field, value, expectedVersion } = req.body || {};
    const session = await checkoutSessionService.stampSideEffect({
      id: req.params.id,
      field,
      value: value ? new Date(value) : null,
      expectedVersion, // M2 P2 — optional, see /transition
    });
    res.json(session);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/customer-signature
//   body: { signatureDataUrl, signerName? } — persists the customer's
//   in-person Step 6 signature to the agreement and stamps customerSignedAt.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/customer-signature', async (req, res) => {
  try {
    const { signatureDataUrl, signerName, expectedVersion } = req.body || {};
    const session = await checkoutSessionService.saveCustomerSignature({
      id: req.params.id,
      signatureDataUrl,
      signerName,
      customerIp: req.ip,
      expectedVersion, // M2 P2 — optional, see /transition
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
// POST /api/checkout-sessions/:id/send-customer-inspection
//   2026-06-11 — step 4 "Send inspection link to customer". Requires the
//   tenant setting ON. Emails the 24h link + disclosures and walks the
//   session through the normal state machine to CLOSED (finalize cascade
//   + agreement email run untouched). Plan:
//   doc/customer-inspection-plan-2026-06-11.md
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/send-customer-inspection', async (req, res) => {
  try {
    const { customerInspectionService } = await import('../customer-inspection/customer-inspection.service.js');
    const out = await customerInspectionService.sendCustomerInspection({
      sessionId: req.params.id,
      actorUserId: req.user?.id,
    });
    res.status(201).json(out);
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
// POST /api/checkout-sessions/:id/charge
//   Legacy one-shot — runs sale + preauth back to back, rolls back the
//   sale if preauth fails. Kept for backward compatibility with the
//   wizard's old Step 3 flow; new wizard versions use /charge-sale +
//   /hold-deposit (the two-tap flow below).
//   Body: { amount, depositAmount? }.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/charge', async (req, res) => {
  try {
    const { amount, depositAmount } = req.body || {};
    const result = await spinChargeService.runChargeSequence({
      sessionId: req.params.id,
      amount: Number(amount),
      depositAmount: depositAmount != null ? Number(depositAmount) : undefined,
      actorUserId: req.user?.id,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/charge-sale
//   2026-05-29 — Two-tap Step 3a. Runs the sale on the terminal (fresh
//   tap), captures card-on-file from the response, persists a payment
//   row. Does NOT stamp paymentCompletedAt — the wizard fires
//   /hold-deposit next (or skips if balance was $0).
//   Body: { amount }.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/charge-sale', async (req, res) => {
  try {
    const { amount } = req.body || {};
    const result = await spinChargeService.runSale({
      sessionId: req.params.id,
      amount: Number(amount),
      actorUserId: req.user?.id,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/hold-deposit
//   2026-05-29 — Two-tap Step 3b. Pre-auths the security deposit on a
//   FRESH card tap (no token reuse — customer's second physical tap).
//   On success persists depositHoldId + expiry on the agreement and
//   stamps paymentCompletedAt so the wizard auto-advances.
//   Body: { depositAmount? }. Server resolves the actual amount from
//   the agreement (column → SECURITY_DEPOSIT charge sum → hint → default).
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/hold-deposit', async (req, res) => {
  try {
    const { depositAmount } = req.body || {};
    const result = await spinChargeService.runDepositHold({
      sessionId: req.params.id,
      depositAmount: depositAmount != null ? Number(depositAmount) : undefined,
      actorUserId: req.user?.id,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/record-manual-payment
//   2026-05-29 — Failsafe when the Spin terminal is down or the agent
//   collected payment another way. Writes the same payment row a real
//   sale would but with the chosen method (CASH/CHECK/CARD/OTHER) and
//   a clear notes audit trail.
//   Body: { amount, method, reference?, notes? }.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/record-manual-payment', async (req, res) => {
  try {
    const { amount, method, reference, notes } = req.body || {};
    const result = await spinChargeService.recordManualSale({
      sessionId: req.params.id,
      amount: Number(amount),
      method,
      reference,
      notes,
      actorUserId: req.user?.id,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// POST /api/checkout-sessions/:id/record-manual-deposit
//   2026-05-29 — Failsafe for the security deposit when the Spin pre-auth
//   can't run (terminal down, customer paid cash, external authorization).
//   Persists depositHoldId + amount and stamps paymentCompletedAt so the
//   wizard advances. Reason is REQUIRED for the audit trail.
//   Body: { amount, method, reason, reference? }.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/record-manual-deposit', async (req, res) => {
  try {
    const { amount, method, reason, reference } = req.body || {};
    const result = await spinChargeService.recordManualDeposit({
      sessionId: req.params.id,
      amount: Number(amount),
      method,
      reason,
      reference,
      actorUserId: req.user?.id,
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// ---------------------------------------------------------------------
// GET /api/checkout-sessions/:id/terminal-status
//   Wraps Spin /TerminalStatus so the wizard can poll for terminal
//   readiness before/during the charge. Returns a compact { online,
//   message, raw } shape.
// ---------------------------------------------------------------------
checkoutSessionRouter.get('/:id/terminal-status', async (req, res) => {
  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { id: req.params.id },
      include: { reservation: { select: { tenantId: true } } },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const raw = await spinClient.terminalStatus({}).catch((err) => ({ error: err.message }));
    res.json({
      online: !raw?.error && (raw?.StatusCode === '0' || raw?.StatusCode === '0000'),
      message: raw?.Message || raw?.error || '',
      raw,
    });
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
