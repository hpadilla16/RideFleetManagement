import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { syncVehicleStatusForReservation } from '../vehicles/vehicle-status-sync.js';
import { ensureNoVehicleConflict } from '../reservations/reservations.service.js';
import { recordMileageEntrySafe } from '../vehicles/mileage-history.service.js';
import { fuelLevelToFraction } from '../rental-agreements/inspection-photos-normalize.js';
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

  // 2026-06-04 — vehicle-conflict gate. The wizard previously ran NO conflict
  // check, so a vehicle still out on an open (even overdue) rental could be
  // checked out to a second reservation (Sentry: RES-819679 double-booking).
  // Block at session start with a clear 409 so the agent can check the other
  // rental in (or swap vehicles) before the customer signs anything.
  const resv = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { id: true, tenantId: true, vehicleId: true, pickupAt: true, returnAt: true },
  });

  // beta.116 — NO-CAR-NO-CHECKOUT guard. A reservation without a vehicle must
  // never enter the checkout wizard: it was producing CHECKED_OUT reservations
  // and FINALIZED agreements with no car on the contract (reported 2026-06-05).
  // Block at session start with a clear 422 so step 1 can't be passed until a
  // vehicle is assigned. (Finalize has a matching guard as defense-in-depth.)
  if (!resv) throw new CheckoutSessionError('Reservation not found', 404);
  if (!resv.vehicleId) {
    throw new CheckoutSessionError(
      'Assign a vehicle to this reservation before starting checkout.',
      422,
      'NO_VEHICLE_ASSIGNED',
    );
  }

  if (resv?.vehicleId) {
    try {
      await ensureNoVehicleConflict({
        vehicleId: resv.vehicleId,
        pickupAt: resv.pickupAt,
        returnAt: resv.returnAt,
        ignoreReservationId: resv.id,
      }, { tenantId: resv.tenantId || tenantId || undefined });
    } catch (err) {
      throw new CheckoutSessionError(err.message, err.statusCode || 409, 'VEHICLE_CONFLICT');
    }
  }

  const existing = await prisma.checkoutSession.findUnique({ where: { reservationId } });
  if (existing) {
    if (isTerminal(existing.currentStep)) {
      throw new CheckoutSessionError(
        `Reservation already has a ${existing.currentStep.toLowerCase()} checkout session`,
        409,
        'SESSION_TERMINAL',
      );
    }
    // If a session exists but somehow has no agreement bound (legacy
    // sessions from before this auto-create patch, or a session opened
    // on a reservation that didn't have an agreement yet), back-fill
    // the agreementId now so step 2 onward works.
    if (!existing.agreementId) {
      const agreementId = await ensureAgreementExists({ reservationId, tenantId, actorUserId });
      if (agreementId) {
        const updated = await prisma.checkoutSession.update({
          where: { id: existing.id },
          data: { agreementId },
        });
        logger.info('[checkout-session] backfilled agreementId on existing session', {
          sessionId: existing.id, reservationId, agreementId,
        });
        return updated;
      }
    }
    return existing;
  }

  // 2026-05-28 — auto-create the agreement if it doesn't exist.
  //
  // Pre-redesign, the legacy "Start Rental" button on the reservation
  // detail page was the only path that created a RentalAgreement. The
  // new state-machine wizard skips that button entirely, so reservations
  // hitting the wizard fresh would have agreementId=null and step 2's
  // terms-signing endpoint would 409 with "No agreement linked".
  //
  // Same fix as legacy: route through rentalAgreementsService.startFromReservation
  // so the new agreement gets the customer snapshot, vehicle, pricing rows,
  // and any pre-checkin charges copied over verbatim.
  const agreementId = await ensureAgreementExists({ reservationId, tenantId, actorUserId });

  const session = await prisma.checkoutSession.create({
    data: {
      reservationId,
      agreementId: agreementId || null,
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
    sessionId: session.id, reservationId, agreementId,
  });

  return session;
}

/**
 * Find or create the RentalAgreement bound to this reservation. Returns
 * the agreement id, or null when the reservation itself can't be loaded
 * (caller decides whether to throw or proceed with agreementId=null).
 *
 * Dynamic-imports rental-agreements.service so the checkout module
 * doesn't pull in Puppeteer + Sentry transitively at boot — same lazy
 * pattern the email-on-finalize hook uses.
 */
async function ensureAgreementExists({ reservationId, tenantId, actorUserId }) {
  const existing = await prisma.rentalAgreement.findUnique({
    where: { reservationId },
    select: { id: true },
  });
  if (existing) return existing.id;

  try {
    const { rentalAgreementsService } = await import('../rental-agreements/rental-agreements.service.js');
    const scope = tenantId ? { tenantId } : null;
    const created = await rentalAgreementsService.startFromReservation(reservationId, scope, actorUserId || null);
    logger.info('[checkout-session] auto-created agreement', {
      reservationId, agreementId: created?.id, actorUserId,
    });
    return created?.id || null;
  } catch (err) {
    // Surface the underlying error so the UI can show it instead of
    // silently failing. The most likely cause is a tenant scope mismatch
    // (reservation belongs to a different tenant than the caller) or
    // the reservation being in CANCELLED/NO_SHOW status.
    logger.error('[checkout-session] failed to auto-create agreement', {
      reservationId, message: err?.message || String(err),
    });
    throw new CheckoutSessionError(
      `Could not start agreement for this reservation: ${err?.message || 'unknown error'}`,
      err?.status || 500,
      'AGREEMENT_AUTO_CREATE_FAILED',
    );
  }
}

async function getById(id, { tenantId } = {}) {
  if (!id) return null;
  const where = tenantId ? { id, tenantId } : { id };
  return prisma.checkoutSession.findFirst({ where });
}

async function getByReservationId(reservationId, { tenantId, actorUserId } = {}) {
  if (!reservationId) return null;

  // reservationId is UNIQUE on CheckoutSession (one session per reservation),
  // so we can safely lookup by reservationId alone and apply the tenant scope
  // as a SECONDARY check. This is more forgiving than `where: { reservationId, tenantId }`
  // because it doesn't silently 404 on sessions created before tenantId was
  // back-filled (Phase 1 sessions ran with tenantId=null while the auto-create
  // was still routing through super-admin context).
  let session = await prisma.checkoutSession.findUnique({ where: { reservationId } });
  if (!session) return null;

  // Apply tenant scope as a soft check. If the session has a tenantId and it
  // mismatches the caller's tenantId, we refuse. If the session has null
  // tenantId (legacy), we accept and back-fill below.
  if (tenantId && session.tenantId && session.tenantId !== tenantId) {
    return null;
  }

  // 2026-05-28 — Back-fill missing tenantId from the reservation when it's
  // null on the session. This heals Phase 1 sessions that were created
  // before the tenantId propagation patch and lets the customer-view
  // tenant-scoped query find them on the next poll.
  if (!session.tenantId && !isTerminal(session.currentStep)) {
    try {
      const res = await prisma.reservation.findUnique({
        where: { id: reservationId }, select: { tenantId: true },
      });
      if (res?.tenantId) {
        session = await prisma.checkoutSession.update({
          where: { id: session.id },
          data: { tenantId: res.tenantId },
        });
        logger.info('[checkout-session] self-healed missing tenantId on get', {
          sessionId: session.id, reservationId, tenantId: res.tenantId,
        });
      }
    } catch (err) {
      logger.warn('[checkout-session] tenantId back-fill failed', {
        sessionId: session.id, message: err?.message || String(err),
      });
    }
  }

  // 2026-05-28 — Self-heal sessions created before the auto-create
  // agreement patch landed. If a non-terminal session has no agreement
  // bound, back-fill it now so step 2 (T&C signing) doesn't 409 with
  // "no agreement linked".
  if (!session.agreementId && !isTerminal(session.currentStep)) {
    try {
      const agreementId = await ensureAgreementExists({
        reservationId,
        tenantId: session.tenantId || tenantId || null,
        actorUserId: actorUserId || null,
      });
      if (agreementId) {
        const updated = await prisma.checkoutSession.update({
          where: { id: session.id },
          data: { agreementId },
        });
        logger.info('[checkout-session] self-healed missing agreementId on get', {
          sessionId: session.id, reservationId, agreementId,
        });
        return updated;
      }
    } catch (err) {
      // Don't fail the read just because the back-fill couldn't run —
      // log and return the session as-is so the wizard can still display
      // it. Step 2 will surface the underlying agreement-create error
      // when the customer actually tries to sign.
      logger.warn('[checkout-session] self-heal agreement back-fill failed', {
        sessionId: session.id, reservationId, message: err?.message || String(err),
      });
    }
  }

  return session;
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
    // NOTE (2026-06-05): the wizard used to double-fire this transition on
    // rapid double-click / auto-advance races, producing benign 409s here.
    // The frontend now carries an in-flight guard and treats "already at or
    // past toStep" 409s as a no-op. Intentionally NOT made idempotent
    // server-side — a hard 409 stays the safety net on this payment path.
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

  // 2026-05-28 — Phase 3.5 — Email-on-finalize.
  //
  // When the wizard reaches CLOSED, the customer has a fully signed,
  // paid, inspected rental agreement. Fire a fire-and-forget delivery
  // so they get a PDF copy in their inbox without anyone having to
  // remember to click "Email Agreement". The send goes through the
  // existing scheduleEmailDelivery path which handles Puppeteer +
  // SMTP off the request thread and writes its own audit-log line on
  // failure.
  //
  // Guarded by:
  //   - toStep === 'CLOSED' (only fire once on the actual finalize)
  //   - session.agreementId present (no agreement, nothing to email)
  //   - any throw is swallowed — never let an email hiccup break the
  //     transition response that the UI is waiting on
  if (toStep === 'CLOSED' && updated.agreementId) {
    Promise.resolve()
      .then(() => maybeSendFinalizeEmail(updated, actorUserId))
      .catch((err) => {
        logger.warn('[checkout-session] auto-email-on-finalize failed', {
          sessionId: id, agreementId: updated.agreementId, error: err?.message || String(err),
        });
      });
  }

  // On finalize, advance the reservation to CHECKED_OUT, finalize the agreement,
  // and sync the vehicle to ON_RENT. The redesign reached CLOSED but never did
  // this, so reservations stayed CONFIRMED and cars weren't marked rented.
  if (toStep === 'CLOSED' && updated.reservationId) {
    try {
      const resv = await prisma.reservation.findUnique({
        where: { id: updated.reservationId },
        select: { id: true, status: true, vehicleId: true, tenantId: true },
      });
      // Don't downgrade an already checked-in/out reservation.
      if (resv && !['CHECKED_OUT', 'CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(String(resv.status))) {
        // beta.116 — NO-CAR-NO-CHECKOUT guard (defense-in-depth). Never finalize
        // a checkout onto a reservation with no vehicle: that produced FINALIZED
        // agreements with no car on the contract. The session-start gate blocks
        // the normal path; this catches resumed/legacy sessions that lost their
        // vehicle. Fail the finalize loudly so the agent assigns a car.
        if (!resv.vehicleId) {
          throw new CheckoutSessionError(
            'Cannot finalize checkout: no vehicle is assigned to this reservation.',
            422,
            'NO_VEHICLE_ASSIGNED',
          );
        }
        // 2026-06-04 — defense-in-depth: re-run the vehicle-conflict gate at
        // finalize too. The session-start gate covers the normal flow, but a
        // long-lived/resumed session could finalize after another rental took
        // the vehicle. Surfaces as a clean 409, never a silent double-booking.
        {
          const resvFull = await prisma.reservation.findUnique({
            where: { id: resv.id }, select: { pickupAt: true, returnAt: true },
          });
          await ensureNoVehicleConflict({
            vehicleId: resv.vehicleId,
            pickupAt: resvFull?.pickupAt,
            returnAt: resvFull?.returnAt,
            ignoreReservationId: resv.id,
          }, { tenantId: resv.tenantId || undefined });
        }
        await prisma.reservation.update({ where: { id: resv.id }, data: { status: 'CHECKED_OUT' } });
        if (updated.agreementId) {
          // 2026-06-10 (beta.152) — this cascade finalize never copied the
          // mobile-captured odometer/fuel from the CHECKOUT inspection row
          // onto the agreement columns, so contracts printed "-" and the
          // beta.143 mileage-history CHECKOUT entry was silently skipped.
          // Copy them here (agreement column wins if already set) and record
          // the mileage entry. All best-effort: metric/mileage failures must
          // never break the finalize itself.
          let metricsPatch = {};
          let checkoutOdometer = null;
          try {
            const [agRow, inspRow] = await Promise.all([
              prisma.rentalAgreement.findUnique({
                where: { id: updated.agreementId },
                select: { odometerOut: true, fuelOut: true, agreementNumber: true },
              }),
              prisma.rentalAgreementInspection.findFirst({
                where: { rentalAgreementId: updated.agreementId, phase: 'CHECKOUT' },
                select: { odometer: true, fuelLevel: true },
              }),
            ]);
            if (agRow && inspRow) {
              if (agRow.odometerOut == null && inspRow.odometer != null) {
                metricsPatch.odometerOut = inspRow.odometer;
              }
              const fuelFraction = fuelLevelToFraction(inspRow.fuelLevel);
              if (agRow.fuelOut == null && fuelFraction != null) {
                metricsPatch.fuelOut = fuelFraction;
              }
            }
            checkoutOdometer = agRow?.odometerOut ?? inspRow?.odometer ?? null;
          } catch { metricsPatch = {}; }

          await prisma.rentalAgreement.update({
            where: { id: updated.agreementId },
            data: { status: 'FINALIZED', finalizedAt: new Date(), ...metricsPatch },
          }).catch(() => {});

          // Mileage history ("last entry wins" — same as the legacy finalize).
          if (checkoutOdometer != null && resv.vehicleId) {
            await recordMileageEntrySafe(prisma, {
              vehicleId: resv.vehicleId,
              tenantId: resv.tenantId || undefined,
              mileage: checkoutOdometer,
              source: 'CHECKOUT',
              reservationId: resv.id,
              rentalAgreementId: updated.agreementId,
              actorUserId: actorUserId || null,
            });
          }
        }
        await syncVehicleStatusForReservation(prisma, {
          reservationId: resv.id, vehicleId: resv.vehicleId, toStatus: 'CHECKED_OUT',
        });
        await prisma.auditLog.create({
          data: {
            tenantId: resv.tenantId, reservationId: resv.id, actorUserId: actorUserId || null,
            action: 'STATUS_CHANGE', fromStatus: resv.status, toStatus: 'CHECKED_OUT',
            reason: 'Checkout wizard finalized',
          },
        }).catch(() => {});
        logger.info('[checkout-session] reservation advanced to CHECKED_OUT on finalize', {
          sessionId: id, reservationId: resv.id,
        });
      }
    } catch (err) {
      // 2026-06-04 — vehicle conflicts must FAIL the finalize loudly (the
      // agent has to see it at the counter), not be swallowed like the
      // best-effort email/audit failures below.
      if (err?.statusCode === 409 || err instanceof CheckoutSessionError) {
        throw err instanceof CheckoutSessionError
          ? err
          : new CheckoutSessionError(err.message, 409, 'VEHICLE_CONFLICT');
      }
      logger.warn('[checkout-session] failed to advance reservation on finalize', {
        sessionId: id, reservationId: updated.reservationId, error: err?.message || String(err),
      });
    }
  }

  return updated;
}

/**
 * Best-effort customer email on CheckoutSession finalize. Dynamically
 * imports the rental-agreements service so the checkout module doesn't
 * pull in Puppeteer at boot (it stays a heavy lazy dependency).
 *
 * Marks autoEmailedAt on the session so we know not to fire twice if
 * a future code path re-runs the transition path. The session column
 * is added in the same Phase 3.5 migration that ships this code.
 */
async function maybeSendFinalizeEmail(session, actorUserId) {
  if (!session?.agreementId) return;
  // Already sent? Don't double-fire. (Session row may have been
  // transitioned again by an admin tool, retry queue, etc.)
  if (session.autoEmailedAt) return;

  const { rentalAgreementsService } = await import('../rental-agreements/rental-agreements.service.js');

  // Stamp the marker BEFORE firing the scheduler so two near-simultaneous
  // transitions (race condition) can't both fire. We use updateMany with
  // a null guard so only the first one wins.
  const stamped = await prisma.checkoutSession.updateMany({
    where: { id: session.id, autoEmailedAt: null },
    data: { autoEmailedAt: new Date() },
  });
  if (stamped.count === 0) return; // someone else already stamped — skip

  rentalAgreementsService.scheduleEmailDelivery(
    session.agreementId,
    {}, // empty payload → default recipient = live customer email
    actorUserId || null,
    session.tenantId || null,
    { logger },
  );
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
  // Read current events, append, then commit in a single update so the
  // events log + side-effect timestamp move together. The previous
  // version passed an empty object for events and exploded with a
  // Prisma validation error.
  const current = await prisma.checkoutSession.findUnique({
    where: { id }, select: { events: true },
  });
  if (!current) throw new CheckoutSessionError('Session not found', 404);
  return prisma.checkoutSession.update({
    where: { id },
    data: {
      [field]: at,
      events: appendEvent(current.events, {
        kind: 'SIDE_EFFECT', field, at: at.toISOString(),
      }),
    },
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

  // 2026-05-28 — Idempotent within the TTL window.
  //
  // The agent's wizard mints a token on step entry, AND the customer-facing
  // display ALSO mints one to render the same QR. We want them to share the
  // QR, not race-create two tokens of which one is silently abandoned.
  // Strategy: if there's an existing same-kind token for this reservation
  // that's not consumed and has > 2 minutes left, return it as-is. Below
  // the 2-minute floor we mint fresh so the customer never sees a QR that
  // expires while they're scanning it.
  const TWO_MINUTES = 2 * 60_000;
  const existing = await prisma.handoffToken.findFirst({
    where: {
      reservationId: session.reservationId,
      kind,
      consumedAt: null,
      expiresAt: { gt: new Date(Date.now() + TWO_MINUTES) },
    },
    orderBy: { expiresAt: 'desc' },
  });
  if (existing) {
    return {
      token: existing.token,
      expiresAt: existing.expiresAt,
      kind: existing.kind,
      reused: true,
    };
  }

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
  if (row.expiresAt < new Date()) {
    throw new CheckoutSessionError('Token expired', 410, 'TOKEN_EXPIRED');
  }
  // 2026-06-04 — RELOAD TOLERANCE. Hard single-use broke real phones:
  // Android kills the browser tab when the customer switches to the camera
  // mid-inspection (or the page otherwise reloads), and the re-exchange hit
  // TOKEN_CONSUMED → "link expired" mid-flow (employees reported QR
  // problems; logs show 410s during active sessions). The token now remains
  // exchangeable until expiresAt — the short TTL is the security boundary,
  // consumedAt just records first use.
  if (!row.consumedAt) {
    await prisma.handoffToken.update({
      where: { id: row.id }, data: { consumedAt: new Date() },
    }).catch(() => {});
  }

  return {
    reservation: row.reservation,
    kind: row.kind,
    consumedAt: row.consumedAt || new Date(),
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
