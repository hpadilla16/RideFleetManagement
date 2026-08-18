import { Router } from 'express';
import { checkoutSessionService, CheckoutSessionError } from './checkout-session.service.js';
import { vehicleSwapService } from './vehicle-swap.service.js';
import { spinChargeService } from './spin-charge.service.js';
import { spinClient } from '../payment-gateway/spin-client.js';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { isSuperAdmin } from '../../middleware/auth.js';

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

// ---------------------------------------------------------------------
// Fail-closed floor for the whole router (2026-08-17).
//
// `getTenantScope` below returns null for a non-super-admin with no
// tenantId, and null does NOT mean "deny" downstream — it means "no
// filter": getById does `tenantId ? { id, tenantId } : { id }`, and
// getByReservationId skips its ownership check entirely. So a tenantless
// account read across tenants on the two routes the `:id` guard cannot
// cover (`POST /` and `GET /by-reservation/:reservationId`).
//
// lib/tenant-scope.js exists precisely because this state is considered
// reachable — its DENY_ALL_SCOPE comment says it would "rather fail closed
// than return all tenants' data". This is that posture, one layer up.
//
// Deliberately NOT `scopeFor(req)`: that returns the '__no_tenant__'
// sentinel, and createForReservation would write that string straight into
// CheckoutSession.tenantId.
// ---------------------------------------------------------------------
checkoutSessionRouter.use((req, res, next) => {
  if (!isSuperAdmin(req.user) && !req.user?.tenantId) {
    logger.warn('[checkout-session] refused a caller with no tenant', {
      actorUserId: req.user?.id || req.user?.sub || null,
      method: req.method,
      path: req.originalUrl,
    });
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
});

function getTenantScope(req) {
  // SUPER_ADMIN can pass ?tenantId=...; everyone else is scoped to
  // req.user.tenantId. Same pattern as other routers.
  const role = String(req.user?.role || '').toUpperCase();
  if (role === 'SUPER_ADMIN') return req.query.tenantId || req.user?.tenantId || null;
  return req.user?.tenantId || null;
}

/**
 * Scope for STARTING a session (2026-08-17, QA MAJOR-1).
 *
 * `getTenantScope` falls back to `req.user.tenantId` for a SUPER_ADMIN, so a
 * super admin who HAS a tenant of their own (the shape backend/scripts/seed-dev.mjs
 * creates) resolves to that tenant rather than to "unrestricted". Feeding that
 * into createForReservation's tenant gate would refuse them on every other
 * tenant's reservation with a 404 saying the reservation does not exist — while
 * the `:id` guard above waves the same account through every OTHER route
 * cross-tenant. The router and the service would disagree about what
 * SUPER_ADMIN means.
 *
 * Here null means "no tenant constraint", which is only safe because the new
 * session is stamped from `resv.tenantId` (see createForReservation) rather
 * than from the caller — so an unconstrained scope can no longer mis-stamp a
 * session into the wrong tenant, which was the original bug.
 */
function getCreateTenantScope(req) {
  if (isSuperAdmin(req.user)) return req.query?.tenantId ? String(req.query.tenantId) : null;
  return req.user?.tenantId || null;
}

// ---------------------------------------------------------------------
// TENANT GUARD for every `:id`-addressed route on this router.
//
// 2026-08-17 — QA raised this on fix/checkout-finalize-truth. Only three
// handlers here (POST /, GET /:id, GET /by-reservation/:reservationId)
// resolved a tenant scope; the other fourteen took `req.params.id` and
// acted on it with no tenant check at all. The router is mounted behind
// `requireModuleAccess('reservations')` (main.js), so ANY authenticated
// user with the reservations module could drive another tenant's checkout
// session by id: finalize it (→ CHECKED_OUT + FINALIZED agreement +
// vehicle ON_RENT + contract emailed to their customer), run a card sale
// or deposit pre-auth on it, mint a handoff token granting access to their
// customer's data, or sign their rental agreement.
//
// Enforced HERE rather than threaded through each service call on purpose:
//
//   • One place, and it covers handlers added later by default. Fourteen
//     per-handler scope lookups is fourteen chances to forget the next one
//     — which is precisely how this happened.
//   • `transition()` / `stampSideEffect()` / `saveCustomerSignature()` are
//     also called SERVICE-TO-SERVICE by kiosk-checkout.service.js and
//     customer-inspection.service.js, which legitimately have no
//     `req.user`. Guarding the router leaves those paths untouched by
//     construction instead of relying on an opt-out flag that a future
//     caller could pass by accident.
//
// Legacy sessions: Phase 1 ran with `CheckoutSession.tenantId = null` (see
// the back-fill in `getByReservationId`). Hard-scoping on the column alone
// would 404 those mid-checkout, so a null-tenant session is attributed via
// its reservation and back-filled — same soft-check semantics the read path
// already uses, never looser.
//
// Denials are 404, not 403: a 403 confirms the id exists in another tenant.
// ---------------------------------------------------------------------
checkoutSessionRouter.param('id', async (req, res, next, id) => {
  try {
    if (!id) return res.status(404).json({ error: 'Not found' });

    const session = await prisma.checkoutSession.findUnique({
      where: { id: String(id) },
      select: { id: true, tenantId: true, reservationId: true },
    });
    if (!session) return res.status(404).json({ error: 'Not found' });

    // SUPER_ADMIN is cross-tenant, same as `getTenantScope` above.
    if (isSuperAdmin(req.user)) {
      req.checkoutSession = session;
      return next();
    }

    const callerTenantId = req.user?.tenantId || null;
    // Fail closed, mirroring lib/tenant-scope.js's DENY_ALL_SCOPE: a
    // non-super-admin with no tenant of their own addresses nothing.
    if (!callerTenantId) return denyCrossTenant(req, res, session, null);

    let ownerTenantId = session.tenantId;

    if (!ownerTenantId && session.reservationId) {
      // Legacy null-tenant session — the reservation is the source of truth.
      const resv = await prisma.reservation
        .findUnique({ where: { id: session.reservationId }, select: { tenantId: true } })
        .catch(() => null);
      ownerTenantId = resv?.tenantId || null;

      if (ownerTenantId) {
        // Self-heal so this session only pays the extra lookup once, and so
        // the strict branch above covers it from here on.
        //
        // DELIBERATE DIVERGENCE from getByReservationId's back-fill, which
        // gates on `!isTerminal(currentStep)`: this one heals terminal
        // sessions too. Healing a CLOSED session changes nothing about it and
        // makes every future read strict, which is what we want on a write
        // path. The .catch below is equally deliberate — the ownership
        // comparison has already happened against the in-memory
        // ownerTenantId, so a failed back-fill is a missed optimisation, not
        // a security hole, and must NOT become a hard failure that 500s a
        // live checkout.
        await prisma.checkoutSession
          .update({ where: { id: session.id }, data: { tenantId: ownerTenantId } })
          .then(() => {
            logger.info('[checkout-session] self-healed missing tenantId in guard', {
              sessionId: session.id, tenantId: ownerTenantId,
            });
          })
          .catch((err) => {
            logger.warn('[checkout-session] tenantId back-fill failed in guard', {
              sessionId: session.id, error: err?.message || String(err),
            });
          });
      }
    }

    // An unattributable session (no tenant on the session AND none on its
    // reservation) stays reachable — the read path is equally lenient there,
    // and refusing would strand a live checkout on a payment path. This is the
    // one residual gap in the guard, so it is LOUD rather than silent: the
    // stamp fix in createForReservation stops new ones being minted, so this
    // set can only shrink. When this line stops appearing in the logs, the
    // branch can become a hard deny (and CheckoutSession.tenantId a NOT NULL
    // column). Log first, tighten once the log is silent.
    if (!ownerTenantId) {
      logger.warn('[checkout-session] unattributable session allowed through guard', {
        sessionId: session.id,
        reservationId: session.reservationId,
        callerTenantId,
        path: req.originalUrl,
      });
    }

    if (ownerTenantId && ownerTenantId !== callerTenantId) {
      return denyCrossTenant(req, res, session, ownerTenantId);
    }

    req.checkoutSession = { ...session, tenantId: ownerTenantId };
    return next();
  } catch (err) {
    return handleError(res, err);
  }
});

/** 404 + a loud log line: a cross-tenant attempt is a security event. */
function denyCrossTenant(req, res, session, ownerTenantId) {
  logger.warn('[checkout-session] cross-tenant access refused', {
    sessionId: session.id,
    ownerTenantId,
    callerTenantId: req.user?.tenantId || null,
    actorUserId: req.user?.id || req.user?.sub || null,
    method: req.method,
    path: req.originalUrl,
  });
  return res.status(404).json({ error: 'Not found' });
}

// ---------------------------------------------------------------------
// POST /api/checkout-sessions — start a session for a reservation
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/', async (req, res) => {
  try {
    const { reservationId } = req.body || {};
    const tenantId = getCreateTenantScope(req);
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
      req.params.reservationId,
      { tenantId, actorUserId: req.user?.id || req.user?.sub || null },
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
// POST /api/checkout-sessions/:id/customer-signature
//   body: { signatureDataUrl, signerName? } — persists the customer's
//   in-person Step 6 signature to the agreement and stamps customerSignedAt.
// ---------------------------------------------------------------------
checkoutSessionRouter.post('/:id/customer-signature', async (req, res) => {
  try {
    const { signatureDataUrl, signerName } = req.body || {};
    const session = await checkoutSessionService.saveCustomerSignature({
      id: req.params.id,
      signatureDataUrl,
      signerName,
      customerIp: req.ip,
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
    // Existence + tenant ownership are both settled by the `:id` guard above.
    // (This used to `select` reservation.tenantId and never compare it, which
    // read like a tenant check but wasn't one.)
    if (!req.checkoutSession) return res.status(404).json({ error: 'Session not found' });
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
