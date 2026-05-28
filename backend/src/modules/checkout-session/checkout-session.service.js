import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import {
  CHECKOUT_STEPS,
  canTransition,
  entryRequirement,
  appendEvent,
  isTerminal,
} from './state-machine.js';

export class CheckoutSessionError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.name = 'CheckoutSessionError';
    this.status = status;
    this.code = code;
  }
}

const HANDOFF_TOKEN_TTL_MIN = 15;

function tokenBytes() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Create a CheckoutSession for the given reservation. Idempotent: if
 * one already exists and is non-terminal, return it. If it's terminal
 * (CLOSED/CANCELLED), refuse — the caller has to explicitly start a
 * new agreement workflow.
 */
async function createForReservation({ reservationId, tenantId, actorUserId }) {
  if (!reservationId) throw new CheckoutSessionError('reservationId required', 400);

  const existing = await prisma.checkoutSession.findUnique({ where: { reservationId } });
  if (existing) {
    if (isTerminal(existing.currentStep)) {
      throw new CheckoutSessionError(
        `Reservation already has a ${existing.currentStep.toLowerCase()} checkout session`,
        409,
        'SESSION_TERMINAL',
      );
    }
    return existing;
  }

  // Bind the agreement at creation time if one already exists. (The
  // current reservation flow auto-creates a DRAFT agreement on confirm,
  // so most paths will have one ready.) If not, we'll link it later.
  const agreement = await prisma.rentalAgreement.findUnique({
    where: { reservationId },
    select: { id: true },
  });

  const session = await prisma.checkoutSession.create({
    data: {
      reservationId,
      agreementId: agreement?.id || null,
      tenantId: tenantId || null,
      currentStep: 'CONFIRMING',
      events: appendEvent('[]', {
        kind: 'SESSION_STARTED',
        actorUserId: actorUserId || null,
      }),
      startedByUserId: actorUserId || null,
    },
  });

  logger.info('[checkout-session] created', {
    sessionId: session.id, reservationId, agreementId: agreement?.id,
  });

  return session;
}

async function getById(id, { tenantId } = {}) {
  if (!id) return null;
  const where = tenantId ? { id, tenantId } : { id };
  return prisma.checkoutSession.findFirst({ where });
}

async function getByReservationId(reservationId, { tenantId } = {}) {
  if (!reservationId) return null;
  const where = tenantId ? { reservationId, tenantId } : { reservationId };
  return prisma.checkoutSession.findFirst({ where });
}

/**
 * Move the session to `toStep`. Validates:
 *   • current step allows this transition (per the state-machine graph)
 *   • required side-effect field is stamped (e.g. tcCompletedAt before
 *     TC_SIGNED is allowed)
 *
 * Stamps any additional timestamp fields based on the destination step
 * (e.g. PAID stamps paymentCompletedAt if not already set). Appends a
 * TRANSITION event to the JSON log.
 */
async function transition({ id, toStep, actorUserId, metadata }) {
  if (!id) throw new CheckoutSessionError('session id required', 400);
  if (!CHECKOUT_STEPS.includes(toStep)) {
    throw new CheckoutSessionError(`Unknown step: ${toStep}`, 400);
  }

  const session = await prisma.checkoutSession.findUnique({ where: { id } });
  if (!session) throw new CheckoutSessionError('Session not found', 404);

  if (!canTransition(session.currentStep, toStep)) {
    throw new CheckoutSessionError(
      `Illegal transition ${session.currentStep} → ${toStep}`,
      409,
      'ILLEGAL_TRANSITION',
    );
  }

  const requiredField = entryRequirement(toStep);
  if (requiredField && !session[requiredField]) {
    throw new CheckoutSessionError(
      `Cannot enter ${toStep}: ${requiredField} is not stamped yet`,
      409,
      'ENTRY_GUARD',
    );
  }

  // Auto-stamp finishedAt when entering a terminal state.
  const data = {
    currentStep: toStep,
    events: appendEvent(session.events, {
      kind: 'TRANSITION',
      from: session.currentStep,
      to: toStep,
      actorUserId: actorUserId || null,
      metadata: metadata || null,
    }),
  };
  if (isTerminal(toStep) && !session.finishedAt) {
    data.finishedAt = new Date();
  }

  const updated = await prisma.checkoutSession.update({ where: { id }, data });
  logger.info('[checkout-session] transition', {
    sessionId: id, from: session.currentStep, to: toStep, actorUserId,
  });
  return updated;
}

/**
 * Stamp one of the side-effect timestamps without performing a
 * transition. Used by the customer's T&C-signing endpoint to mark
 * tcCompletedAt, by the Spin webhook to mark paymentCompletedAt, etc.
 * The transition itself is a separate call from the agent's screen.
 */
async function stampSideEffect({ id, field, value }) {
  if (!id) throw new CheckoutSessionError('session id required', 400);
  const ALLOWED = ['tcCompletedAt', 'paymentCompletedAt', 'inspectionCompletedAt', 'customerSignedAt'];
  if (!ALLOWED.includes(field)) {
    throw new CheckoutSessionError(`Unknown side-effect field: ${field}`, 400);
  }
  const at = value || new Date();
  const session = await prisma.checkoutSession.update({
    where: { id },
    data: {
      [field]: at,
      events: { /* append below */ },
    },
  });
  // Append event in a follow-up update (Prisma doesn't support nested
  // JSON append in one mutation).
  const eventsJson = appendEvent(session.events, {
    kind: 'SIDE_EFFECT',
    field,
    at: at.toISOString(),
  });
  return prisma.checkoutSession.update({
    where: { id }, data: { events: eventsJson },
  });
}

/**
 * Mint a single-use QR token bound to this session's reservation. The
 * customer's phone (TERMS_SIGNING) or the agent's mobile (MOBILE_INSPECTION)
 * exchanges this token at a public route to assert their session without
 * needing to log in.
 */
async function mintHandoffToken({ sessionId, kind, actorUserId }) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);
  if (!['TERMS_SIGNING', 'MOBILE_INSPECTION'].includes(kind)) {
    throw new CheckoutSessionError(`Unknown handoff kind: ${kind}`, 400);
  }
  const session = await prisma.checkoutSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new CheckoutSessionError('Session not found', 404);

  const expiresAt = new Date(Date.now() + HANDOFF_TOKEN_TTL_MIN * 60_000);
  const token = tokenBytes();

  const row = await prisma.handoffToken.create({
    data: {
      reservationId: session.reservationId,
      kind,
      token,
      expiresAt,
      createdByUserId: actorUserId || null,
    },
  });

  await prisma.checkoutSession.update({
    where: { id: sessionId },
    data: {
      events: appendEvent(session.events, {
        kind: 'TOKEN_MINTED',
        tokenKind: kind,
        tokenId: row.id,
        expiresAt: expiresAt.toISOString(),
        actorUserId: actorUserId || null,
      }),
    },
  });

  return {
    token: row.token,
    expiresAt: row.expiresAt,
    kind: row.kind,
  };
}

/**
 * Public exchange — customer's phone scans the QR, we look up the
 * session, return its public-safe state. Token is consumed on success
 * to enforce single-use. Throws 410 if expired/already consumed.
 */
async function exchangeHandoffToken(token) {
  if (!token) throw new CheckoutSessionError('token required', 400);
  const row = await prisma.handoffToken.findUnique({
    where: { token },
    include: {
      reservation: {
        select: {
          id: true, reservationNumber: true, customerId: true, vehicleId: true,
          pickupAt: true, returnAt: true,
        },
      },
    },
  });
  if (!row) throw new CheckoutSessionError('Invalid token', 410, 'TOKEN_INVALID');
  if (row.consumedAt) throw new CheckoutSessionError('Token already used', 410, 'TOKEN_CONSUMED');
  if (row.expiresAt < new Date()) {
    throw new CheckoutSessionError('Token expired', 410, 'TOKEN_EXPIRED');
  }

  await prisma.handoffToken.update({
    where: { id: row.id }, data: { consumedAt: new Date() },
  });

  return {
    reservation: row.reservation,
    kind: row.kind,
    consumedAt: new Date(),
  };
}

/**
 * Explicit abandonment — agent clicked Save & pause. NOT for the nightly
 * cleanup job; that one runs its own sweep against (currentStep, updatedAt).
 */
/**
 * Persist the declined-insurance flag onto the linked RentalAgreement
 * AND record it in the session event log. Used by step 1 of the wizard.
 * Phase 3 (T&C signing) reads agreement.declinedInsurance to decide
 * whether to inject the addendum section into the customer's signing UI.
 */
async function setDeclinedInsurance({ id, declined, actorUserId }) {
  if (!id) throw new CheckoutSessionError('sessionId required', 400);
  const session = await prisma.checkoutSession.findUnique({ where: { id } });
  if (!session) throw new CheckoutSessionError('Session not found', 404);
  if (!session.agreementId) {
    throw new CheckoutSessionError('No agreement linked to this session', 409);
  }

  await prisma.rentalAgreement.update({
    where: { id: session.agreementId },
    data: { declinedInsurance: !!declined },
  });

  return prisma.checkoutSession.update({
    where: { id },
    data: {
      events: appendEvent(session.events, {
        kind: 'DECLINED_INSURANCE',
        declined: !!declined,
        actorUserId: actorUserId || null,
      }),
    },
  });
}

async function markAbandoned({ id, reason, actorUserId }) {
  const session = await prisma.checkoutSession.findUnique({ where: { id } });
  if (!session) throw new CheckoutSessionError('Session not found', 404);
  if (isTerminal(session.currentStep)) {
    throw new CheckoutSessionError('Session is already terminal', 409);
  }
  return prisma.checkoutSession.update({
    where: { id },
    data: {
      abandonedAt: new Date(),
      abandonedReason: reason || 'agent_paused',
      events: appendEvent(session.events, {
        kind: 'ABANDONED',
        reason: reason || 'agent_paused',
        actorUserId: actorUserId || null,
      }),
    },
  });
}

export const checkoutSessionService = {
  createForReservation,
  getById,
  getByReservationId,
  transition,
  stampSideEffect,
  mintHandoffToken,
  exchangeHandoffToken,
  setDeclinedInsurance,
  markAbandoned,
};
