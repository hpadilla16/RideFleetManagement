import crypto from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { syncVehicleStatusForReservation } from '../vehicles/vehicle-status-sync.js';
import { ensureNoVehicleConflict } from '../reservations/reservations.service.js';
import { recordMileageEntrySafe } from '../vehicles/mileage-history.service.js';
import { evaluateAgeRules, ageRuleBlockMessage } from '../../lib/age-rules.js';
import { parseLocationConfig } from '../../lib/location-config.js';
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

/**
 * M2 P2 (2026-08-17) — lightweight optimistic versioning, OPT-IN.
 *
 * With four surfaces on the same session (00-REGROUND.md §2) the remaining
 * concurrency gap was read-then-write: a client acts on a snapshot another
 * surface already moved past — most visibly stampSideEffect, which has no
 * state-machine guard at all (gap #5). CheckoutSession.stateVersion is bumped
 * on every transition / stamp / signature; a caller that sends
 * `expectedVersion` and is stale gets 409 STALE_VERSION *with the fresh row
 * attached* so it can re-render without a second round-trip.
 *
 * STRICTLY OPT-IN: when expectedVersion is absent (web wizard, kiosk,
 * precheckin — every client that exists today) behavior is identical to
 * before. That's the whole retrocompat contract; do NOT make this mandatory.
 */
function assertExpectedVersion(session, expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null) return;
  const expected = Number(expectedVersion);
  if (!Number.isInteger(expected) || expected < 0) {
    throw new CheckoutSessionError(
      'expectedVersion must be a non-negative integer',
      400,
      'BAD_EXPECTED_VERSION',
    );
  }
  if ((session.stateVersion ?? 0) !== expected) {
    const err = new CheckoutSessionError(
      `Session moved on: expected version ${expected}, is ${session.stateVersion ?? 0}`,
      409,
      'STALE_VERSION',
    );
    // Fresh row for the 409 body — the client re-renders from this instead of
    // firing a follow-up GET (the router's handleError forwards it).
    err.session = session;
    throw err;
  }
}

function tokenBytes() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Best-effort pricing recompute (mandatory + underage fees → ReservationCharge
 * → agreement mirror). Runs whenever a wizard session is created OR resumed so
 * the payment step always sees current fee lines — before this, the mirror only
 * refreshed when someone happened to open the reservation detail page. Dynamic
 * import for the same boot-weight reason as ensureAgreementExists.
 */
async function refreshPricingSafe(reservationId, tenantId) {
  try {
    const { reservationPricingService } = await import('../reservations/reservation-pricing.service.js');
    await reservationPricingService.getPricing(reservationId, tenantId ? { tenantId } : {});
  } catch (err) {
    logger.warn('[checkout-session] pricing refresh failed (non-fatal)', {
      reservationId, error: err?.message || String(err),
    });
  }
}

/**
 * 2026-07-28 — per-location checkout gates (LAX meeting), evaluated in order:
 *
 * 1. PRE-CHECKIN gate (#3): with `requirePrecheckinBeforeCheckout` on, the
 *    session refuses to start until Reservation.customerInfoCompletedAt is
 *    stamped — either by the customer (portal pre-checkin) or by staff
 *    ("Completed by staff on behalf of customer" flow). 422 PRECHECKIN_REQUIRED.
 * 2. AGE-RULES gate (#4): with `ageRulesEnforced` on, no DOB / under
 *    chargeAgeMin / over chargeAgeMax refuse check-out with a 422 the wizard
 *    renders as a step-1 blocker (inline DOB capture + retry). The 21–24 band
 *    does NOT block — it surfaces as a notice + mandatory underage fee via
 *    the pricing engine.
 *
 * Runs at session START and again at CLOSE (a DOB corrected mid-wizard, or a
 * resumed legacy session, must not slip past the rules).
 */
async function ensureCheckoutGates(reservationId) {
  const resv = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: {
      pickupAt: true,
      customerInfoCompletedAt: true,
      customer: { select: { dateOfBirth: true } },
      pickupLocation: { select: { locationConfig: true } },
    },
  });
  if (!resv) return null;
  const cfg = parseLocationConfig(resv.pickupLocation?.locationConfig);

  if (cfg.requirePrecheckinBeforeCheckout === true && !resv.customerInfoCompletedAt) {
    throw new CheckoutSessionError(
      'Pre-check-in must be completed before check-out can start at this location.',
      422,
      'PRECHECKIN_REQUIRED',
    );
  }

  const evaluation = evaluateAgeRules({
    dateOfBirth: resv.customer?.dateOfBirth ?? null,
    pickupAt: resv.pickupAt,
    locationConfig: cfg,
  });
  if (evaluation.blocking) {
    throw new CheckoutSessionError(
      ageRuleBlockMessage(evaluation),
      422,
      `AGE_RULES_${evaluation.status}`,
    );
  }
  return evaluation;
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
    select: { id: true, tenantId: true, vehicleId: true, pickupAt: true, returnAt: true, workflowMode: true },
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

  // Checkout gates (pre-checkin + age rules) — run before the existing-session
  // lookup on purpose: resuming a session must not bypass the rules either.
  await ensureCheckoutGates(reservationId);

  const existing = await prisma.checkoutSession.findUnique({ where: { reservationId } });
  if (existing) {
    if (isTerminal(existing.currentStep)) {
      throw new CheckoutSessionError(
        `Reservation already has a ${existing.currentStep.toLowerCase()} checkout session`,
        409,
        'SESSION_TERMINAL',
      );
    }
    await refreshPricingSafe(reservationId, resv.tenantId || tenantId);
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
  await refreshPricingSafe(reservationId, resv.tenantId || tenantId);

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

  // Loaner checkout has no online payment (billing is COURTESY/WARRANTY/etc. on the reservation,
  // or the CUSTOMER_PAY upgrade differential the advisor collects). Pre-stamp paymentCompletedAt
  // so the PAID entry guard passes and the wizard skips the Spin payment step.
  let finalSession = session;
  if (String(resv?.workflowMode) === 'DEALERSHIP_LOANER') {
    finalSession = await prisma.checkoutSession.update({
      where: { id: session.id },
      data: { paymentCompletedAt: new Date() },
    });
  }

  logger.info('[checkout-session] created', {
    sessionId: session.id, reservationId, agreementId,
  });

  return finalSession;
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

  // Loaner reservations get a minimal $0 companion agreement (no rental rates/fees/deposit);
  // rentals go through the full startFromReservation pricing path.
  const wfRow = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { workflowMode: true } });
  const isLoaner = String(wfRow?.workflowMode) === 'DEALERSHIP_LOANER';

  try {
    const { rentalAgreementsService } = await import('../rental-agreements/rental-agreements.service.js');
    const scope = tenantId ? { tenantId } : null;
    const created = isLoaner
      ? await rentalAgreementsService.startLoanerAgreementForCheckout(reservationId, scope)
      : await rentalAgreementsService.startFromReservation(reservationId, scope, actorUserId || null);
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

// H8: the CAS retry budget. See the block comment on transition() — the loop
// exists for CANCELLED, which stays legal from wherever the winner left us.
const CAS_MAX_ATTEMPTS = 3;

/**
 * Move the session to `toStep`. Validates:
 *   • current step allows this transition (per the state-machine graph)
 *   • required side-effect field is stamped (e.g. tcCompletedAt before
 *     TC_SIGNED is allowed)
 *
 * Stamps any additional timestamp fields based on the destination step
 * (e.g. PAID stamps paymentCompletedAt if not already set). Appends a
 * TRANSITION event to the JSON log.
 *
 * ── M2-H8 (2026-08-17) — compare-and-set commit ────────────────────────────
 *
 * Until H8 this read the row and then wrote it unconditionally, so with four
 * surfaces on one session (RideOps, web wizard, kiosk, portal) two callers
 * sitting on the same step could BOTH commit the same hop: two TRANSITION
 * events, two stateVersion bumps, two CLOSED cascades. The commit is now a
 * conditional `updateMany` guarded by the step we actually read (and by
 * stateVersion too when the caller opted into `expectedVersion`), following
 * the `maybeSendFinalizeEmail` precedent below (`updateMany` + `count === 0`
 * → the other writer won).
 *
 * `count === 0` means somebody committed between our read and our write. We
 * re-read and let the next loop pass decide against FRESH state:
 *
 *   • fresh step === toStep, no expectedVersion → IDEMPOTENT SUCCESS. The
 *     transition the caller asked for is a fact; another surface is the one
 *     who wrote it. Answering ILLEGAL_TRANSITION would tell the yard agent
 *     that the step he can see on the screen never happened. The web wizard
 *     already reconstructs this answer client-side (409 → GET → "am I at or
 *     past toStep?" → swallow), so this only moves an existing truth to the
 *     server and saves the round-trip. Attribution stays honest: we append NO
 *     event, so events[] keeps naming the surface that really moved it.
 *     Because canTransition(S, S) is false, this branch also answers the
 *     plain double-submit with no race at all — the endpoint is properly
 *     idempotent, not merely race-tolerant.
 *   • expectedVersion was sent → STALE_VERSION with the fresh row, even when
 *     the step matches. Opting in is opting into strictness: that caller
 *     asked to be told when its snapshot died, and it gets the row back to
 *     re-render from. (Also keeps P2's "stale beats legality" ordering.)
 *   • otherwise → ILLEGAL_TRANSITION / ENTRY_GUARD computed against the
 *     fresh row, so the message names the step the session is REALLY on.
 *
 * The loop matters for exactly one case: `toStep === 'CANCELLED'` stays legal
 * from whatever step the winner left us on, so a cancel that loses the race
 * still cancels instead of 409ing a lie. Forward hops can only re-enter the
 * loop to be answered idempotently or refused, never to double-commit.
 *
 * NOT in the CAS `where`: the ENTRY_REQUIRES field (tcCompletedAt & co).
 * Those stamps only ever go null → value, so the read-then-write window can
 * only turn a FAILING guard into a passing one — never the reverse. Guarding
 * on them would buy no safety and would add a `count === 0` branch that means
 * something else. Pre-check is enough; documented so nobody "fixes" it later.
 *
 * ISOLATION LEVEL — this is correct ONLY under READ COMMITTED (Postgres's
 * default, and what every caller here runs under). The loser of the race
 * blocks on the winner's row lock, RE-EVALUATES the WHERE against the
 * committed row, finds currentStep no longer matches, and returns count: 0 —
 * which is the entire mechanism. Wrap transition() in
 * `$transaction({ isolationLevel: 'Serializable' })` and the loser aborts
 * with P2034 instead: every branch below `count === 0` becomes unreachable,
 * idempotency included, and the caller gets a raw serialization error where
 * it used to get a 200 or a typed 409. If you ever need that isolation
 * level, the `count === 0` handling has to be duplicated in a P2034 catch.
 */
async function transition({ id, toStep, actorUserId, metadata, expectedVersion }) {
  if (!id) throw new CheckoutSessionError('session id required', 400);
  if (!CHECKOUT_STEPS.includes(toStep)) {
    throw new CheckoutSessionError(`Unknown step: ${toStep}`, 400);
  }
  // Opting in is a per-call decision, and it disables the idempotent answer
  // below on purpose — see the block comment.
  const versionGuarded = expectedVersion !== undefined && expectedVersion !== null;

  let updated = null;
  let fromStep = null;
  let alreadyApplied = false;

  for (let attempt = 1; attempt <= CAS_MAX_ATTEMPTS && !updated; attempt += 1) {
    const session = await prisma.checkoutSession.findUnique({ where: { id } });
    if (!session) throw new CheckoutSessionError('Session not found', 404);

    // P2: version check FIRST, before the legality check — a stale caller
    // should learn "your snapshot is old, here's the fresh row" rather than a
    // coincidental ILLEGAL_TRANSITION computed against state it never saw.
    assertExpectedVersion(session, expectedVersion);

    if (!canTransition(session.currentStep, toStep)) {
      // H8: the session is ALREADY where the caller wanted it. Somebody else
      // did the work; report the fact, not a fake refusal. Deliberately
      // narrow — "already at toStep", never "already past toStep": telling an
      // agent that step 2 just succeeded while the session sits on step 5
      // would be a different, worse lie. (Pre-H8 this branch always threw;
      // the wizard's own 409-swallow is what proves the old answer was noise.)
      if (session.currentStep === toStep && !versionGuarded) {
        logger.info('[checkout-session] transition already applied by another surface', {
          sessionId: id, toStep, actorUserId, attempt,
        });
        // NOT an early return. We fall through to the CLOSED cascade below,
        // because "somebody already did it" does not mean "somebody already
        // FINISHED it". The cascade's own failures are swallowed by a
        // logger.warn (see the catch at the end of this function), so a
        // winner whose cascade died half-way leaves the session CLOSED with
        // the reservation still CONFIRMED, the agreement still DRAFT and the
        // vehicle unmarked — and nothing ever retries it. Before H8 the
        // second caller got a 409 that an agent would eventually report;
        // handing it a clean 200 over a half-finalized checkout would be the
        // same species of lie the "already past toStep" cut refuses to tell.
        //
        // The re-run is NOT unconditionally safe, and the first version of
        // this said it was. Two steps inside the cascade are not idempotent:
        // rentalAgreement.update rewrites `finalizedAt` with today's date on
        // an already-FINALIZED contract (audit-trail loss), and
        // recordMileageEntry is a bare create with no dedup, so repeats pile
        // up duplicate mileage rows. What actually contains them is the
        // status short-circuit — which is why SELF_HEAL_OWNS below has to be
        // an allow-list and not a wish. The loaner bump (updateMany guarded
        // by DRAFT) and the email (CAS on autoEmailedAt) are genuinely
        // idempotent on their own.
        alreadyApplied = true;
        updated = session;
        fromStep = session.currentStep;
        break;
      }
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
      // P2: atomic bump — every transition invalidates outstanding
      // expectedVersion snapshots held by other surfaces.
      stateVersion: { increment: 1 },
      // H8: computed from the row we are about to CAS on, so two concurrent
      // transitions can no longer clobber each other's TRANSITION entry — the
      // loser never writes.
      //
      // This is a PARTIAL close of the events lost-update, and the honest
      // count is FOURTEEN other writers of this TEXT column, all still doing
      // an unguarded read-modify-write (read → write, this file):
      //   stampSideEffect       :1048 → :1056
      //   saveCustomerSignature :1078 → :1099  (read is OUTSIDE the
      //                                         $transaction that starts :1084)
      //   mintHandoffToken      :1122 → :1173
      //   setDeclinedInsurance  :1244 → :1258
      //   markAbandoned         :1268 → :1282
      //   checkout-session.scheduler.js:78 (nightly stuck-session sweep)
      //   spin-charge.service.js:574, :606, :884, :1038, :1229 (five)
      //   mobile-inspection.service.js:276
      //   vehicle-swap.service.js:130
      //   terms-signing.service.js:175
      // Any of them can still drop an entry written between its own read and
      // its own write. saveCustomerSignature is the sharpest of the fourteen:
      // its $transaction makes the two WRITES atomic but leaves the READ
      // outside it, and what it writes is customerSignedAt — an
      // ENTRY_REQUIRES field for CLOSED. See the note on stampSideEffect.
      // (Those are ALL the appendEvent callers in the tree; :241 here is the
      // fourteenth-plus-one and does not count — it builds a fresh row on
      // create, with nothing to lose. The kiosk's similarly-named
      // appendEvents(sessionId, device, rawEvents) is a different function
      // writing a different column, KioskSession.events.)
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

    // The compare half of compare-and-set. currentStep is always in the
    // where; stateVersion joins it only for opt-in callers, because guarding
    // every caller on the version would make an unrelated concurrent STAMP
    // (which bumps the version without moving the step) fail transitions for
    // clients that never asked for optimistic concurrency. That would be a
    // regression for the web wizard, the kiosk and precheckin.
    const casWhere = { id, currentStep: session.currentStep };
    if (versionGuarded) casWhere.stateVersion = session.stateVersion ?? 0;

    const { count } = await prisma.checkoutSession.updateMany({ where: casWhere, data });
    if (count > 0) {
      fromStep = session.currentStep;
      // updateMany returns a count, not the row. Re-read rather than
      // reconstruct it locally: the row is what the caller renders, and a
      // stamp landing right after our commit belongs in that answer.
      updated = await prisma.checkoutSession.findUnique({ where: { id } });
      if (!updated) throw new CheckoutSessionError('Session not found', 404);
      break;
    }

    logger.info('[checkout-session] transition lost the CAS race — re-reading', {
      sessionId: id, sawStep: session.currentStep, toStep, attempt,
    });

    if (versionGuarded) {
      // No retry for opt-in callers: their snapshot is provably dead now, and
      // silently re-deciding on state they never saw is the exact thing
      // expectedVersion exists to prevent.
      const fresh = await prisma.checkoutSession.findUnique({ where: { id } });
      if (!fresh) throw new CheckoutSessionError('Session not found', 404);
      const err = new CheckoutSessionError(
        `Session moved on while committing: expected version ${Number(expectedVersion)}, is ${fresh.stateVersion ?? 0}`,
        409,
        'STALE_VERSION',
      );
      err.session = fresh;
      throw err;
    }
  }

  if (!updated) {
    // Three consecutive losses. Real contention this sustained is a bug or an
    // attack, not a counter; refuse loudly with the fresh row attached rather
    // than loop forever.
    const fresh = await prisma.checkoutSession.findUnique({ where: { id } });
    const err = new CheckoutSessionError(
      'Session is being changed by another surface; retry from the fresh state',
      409,
      'CONCURRENT_MODIFICATION',
    );
    if (fresh) err.session = fresh;
    throw err;
  }

  if (!alreadyApplied) {
    logger.info('[checkout-session] transition', {
      sessionId: id, from: fromStep, to: toStep, actorUserId,
    });
  }

  // ── ONE ownership decision, computed once and reused by the cascade AND by
  // the customer email below (2026-08-17, QA MAJOR on the blocker fix) ──────
  //
  // The first version of the blocker fix put the guard only on the cascade.
  // But the email fired FIRST and was gated on nothing but `agreementId`, so
  // the same request that logged "self-heal declined — finalize does not own
  // this reservation (CANCELLED)" went straight on to stamp autoEmailedAt and
  // hand the signed rental contract to scheduleEmailDelivery, for a customer
  // whose reservation staff had cancelled. A write to the world, and the one
  // kind that cannot be taken back.
  //
  // Reachable only with autoEmailedAt === null on a CLOSED session (closed
  // before that column existed, or an agreementId attached later) — narrow,
  // but H8 is what made it reachable at all: before, the repeat POST threw
  // ILLEGAL_TRANSITION and never got here.
  let finalizeOwnsReservation = false;
  let resvRow = null;
  if (toStep === 'CLOSED' && updated.reservationId) {
    try {
      resvRow = await prisma.reservation.findUnique({
        where: { id: updated.reservationId },
        select: { id: true, status: true, vehicleId: true, tenantId: true },
      });
    } catch (err) {
      logger.warn('[checkout-session] could not read reservation for finalize', {
        sessionId: id, reservationId: updated.reservationId, error: err?.message || String(err),
      });
    }
    const resvStatus = String(resvRow?.status ?? '');
    // Never finalize onto a reservation staff has since CANCELLED or marked
    // NO_SHOW. New 2026-08-17 (QA blocker): the old list was a DENY-list
    // naming 3 of the 8 ReservationStatus values, so NEW, CONFIRMED,
    // CANCELLED, NO_SHOW and PENDING_FRANCHISE_IMPORT all fell through it. A
    // session parked in FINALIZING while staff cancels could already finalize
    // onto the cancelled row — pre-existing; H8's self-heal turned it from
    // "needs a parked session" into "any repeat POST". Marking the car ON_RENT
    // for a cancelled rental also collides the NEXT real reservation with
    // "still out on open rental", so the damage does not stay on this row.
    const cancelledLate = ['CANCELLED', 'NO_SHOW'].includes(resvStatus);
    // Self-heal is OPPORTUNISTIC work nobody asked for, so it gets an
    // ALLOW-list instead: only run it on a reservation the finalize
    // legitimately still owns. A deny-list is what failed above, and the bar
    // is higher here — the caller does not know this is happening, and the two
    // non-idempotent steps live inside. PENDING_FRANCHISE_IMPORT is excluded
    // from self-heal for that reason while the winner path is left untouched
    // for it: refusing to guess is free, guessing is not.
    const selfHealOwns = ['NEW', 'CONFIRMED'].includes(resvStatus);
    finalizeOwnsReservation = !!resvRow && !cancelledLate && (!alreadyApplied || selfHealOwns);
    if (!finalizeOwnsReservation) {
      logger.info('[checkout-session] finalize declined — does not own this reservation', {
        sessionId: id, reservationId: updated.reservationId,
        reservationStatus: resvRow?.status ?? null, alreadyApplied,
      });
    }
  }

  // On finalize, advance the reservation to CHECKED_OUT, finalize the agreement,
  // and sync the vehicle to ON_RENT. The redesign reached CLOSED but never did
  // this, so reservations stayed CONFIRMED and cars weren't marked rented.
  //
  // Did the cascade actually finish? The customer email below is gated on
  // this, so it stays false until the whole arm has run.
  let finalizeCascadeOk = false;
  if (toStep === 'CLOSED' && updated.reservationId) {
    try {
      const resv = resvRow;
      // Ownership above, plus the cascade's own "already done" short-circuit:
      // don't downgrade a reservation that is already checked in/out.
      // Did the contract actually become FINALIZED? Flipped only by the
      // rentalAgreement.update below, whose failure is swallowed on purpose.
      let agreementFinalized = true;
      if (finalizeOwnsReservation
        && !['CHECKED_OUT', 'CHECKED_IN', 'CHECKED_IN_UNPAID'].includes(String(resv.status))) {
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
        // Gates re-check (defense-in-depth, mirrors the vehicle gates): a DOB
        // edited/cleared mid-wizard must fail the finalize loudly, and a
        // CheckoutSessionError rethrows past the best-effort catch below.
        await ensureCheckoutGates(resv.id);
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

          // 2026-08-17 (Innovation MUST-CHANGE): this is the write that turns a
          // DRAFT into the legal document, and it used to fail into
          // `.catch(() => {})` — silently, with the cascade carrying on to mark
          // the car ON_RENT and mail the customer their "contract". That is the
          // exact tuple this ticket exists to kill, reached through a different
          // door. It stays best-effort in the sense that a blip here must not
          // abort the rest of the cascade (aborting would strand the vehicle
          // sync, and the self-heal cannot repair it: its short-circuit sees an
          // already-CHECKED_OUT reservation and declines). But it is no longer
          // silent, and it no longer lets the email out — see finalizeCascadeOk.
          await prisma.rentalAgreement.update({
            where: { id: updated.agreementId },
            data: { status: 'FINALIZED', finalizedAt: new Date(), ...metricsPatch },
          }).catch((agErr) => {
            agreementFinalized = false;
            logger.error('[checkout-session] agreement did NOT reach FINALIZED on finalize', {
              sessionId: id, agreementId: updated.agreementId, reservationId: resv.id,
              error: agErr?.message || String(agErr),
            });
          });
          // Loaner companion: advance the borrower's LoanerAgreement to ACTIVE so the portal,
          // due-soon/overdue reminders (status:ACTIVE), and the dashboard badge reflect the
          // checked-out loaner. Harmless for rentals (no LoanerAgreement). (best-effort)
          await prisma.loanerAgreement.updateMany({
            where: { reservationId: resv.id, status: 'DRAFT' },
            data: { status: 'ACTIVE' },
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
        // The cascade ran. It counts as OK only if the contract is really
        // FINALIZED — mailing a DRAFT is the whole ticket.
        finalizeCascadeOk = agreementFinalized;
      } else if (finalizeOwnsReservation) {
        // The benign short-circuit: a finalize landing on a reservation already
        // CHECKED_OUT. No work to do, and the world already matches.
        finalizeCascadeOk = true;
      }
      // Deliberately NOT set when finalizeOwnsReservation is false. Set once at
      // the end of the try — as the first version of this did — the flag was
      // also true for a finalize the ownership guard had just DECLINED, and the
      // only thing keeping H8's cancelled-customer email from coming back was
      // the second `finalizeOwnsReservation` conjunct on the email arm. Two
      // guards where one reads as sufficient is how that regression returns.
      // Anything that throws — the guards inside, or a DB failure the catch
      // downgrades to a logger.warn — skips all of this, which is what stops
      // the email on a half-finished finalize.
    } catch (err) {
      // 2026-06-04 — vehicle conflicts must FAIL the finalize loudly (the
      // agent has to see it at the counter), not be swallowed like the
      // best-effort email/audit failures below.
      if (err?.statusCode === 409 || err instanceof CheckoutSessionError) {
        const fail = err instanceof CheckoutSessionError
          ? err
          : new CheckoutSessionError(err.message, 409, 'VEHICLE_CONFLICT');
        // H8 gave the SELF-HEAL path this re-label, because raising the raw
        // guard code on a visibly CLOSED session reads as nonsense to the
        // agent — a 422 PRECHECKIN_REQUIRED on a finished checkout.
        //
        // 2026-08-17: the WINNER path gets it too, and the `alreadyApplied`
        // branch is gone. The distinction never described anything the agent
        // or RideOps can observe. transition() commits the step BEFORE this
        // cascade runs, so by the time we are in this catch the session is
        // CLOSED either way, and what is left behind is the same either way:
        // reservation still CONFIRMED, contract still DRAFT, car still
        // AVAILABLE. Splitting one state across two error codes bought
        // nothing and cost the wizard its toast — a winner that died on the
        // double-booking guard threw a bare 409 VEHICLE_CONFLICT, whose step
        // comparison (`at >= want`, CLOSED vs CLOSED) the wizard's swallow
        // rule satisfies by construction. The agent saw the finished-checkout
        // screen over a rental that was never handed over.
        //
        // The underlying reason survives twice: in the message, for the human
        // at the counter, and on `.reason`, which the router serializes so
        // RideOps can branch on it without parsing prose.
        const incomplete = new CheckoutSessionError(
          `Checkout is closed but its finalize did not complete: ${fail.message}`,
          409,
          'FINALIZE_INCOMPLETE',
        );
        incomplete.reason = fail.code || null;
        throw incomplete;
      }
      logger.warn('[checkout-session] failed to advance reservation on finalize', {
        sessionId: id, reservationId: updated.reservationId, error: err?.message || String(err),
      });
    }
  }

  // 2026-05-28 — Phase 3.5 — Email-on-finalize.
  //
  // When the wizard reaches CLOSED, the customer has a fully signed, paid,
  // inspected rental agreement. Fire a fire-and-forget delivery so they get a
  // PDF copy in their inbox without anyone having to remember to click "Email
  // Agreement". The send goes through the existing scheduleEmailDelivery path,
  // which handles Puppeteer + SMTP off the request thread and writes its own
  // audit-log line on failure.
  //
  // ── it runs AFTER the cascade, not before (2026-08-17) ───────────────────
  //
  // It used to be the first thing this function did on CLOSED, which put the
  // one irreversible write in the whole finalize AHEAD of every guard that
  // decides whether the finalize is allowed to happen: NO_VEHICLE_ASSIGNED,
  // ensureCheckoutGates (pre-checkin, age rules) and the double-booking
  // re-check all live in the cascade. A finalize that died on any of them had
  // already handed the customer a contract for a rental that was never handed
  // over — and the contract it mailed was still DRAFT, because the FINALIZED
  // stamp is also in the cascade. The same held for the failures the catch
  // above downgrades to a logger.warn: the half-finished finalize that H8's
  // self-heal exists to repair had already emailed its DRAFT.
  //
  // Nothing depended on the old ordering. The mail is fire-and-forget in both
  // positions, so the transition response the UI waits on is unaffected, and
  // rendering the PDF after the cascade is strictly better: it prints a
  // FINALIZED agreement carrying the odometer/fuel the cascade just copied.
  //
  // Guarded by:
  //   - toStep === 'CLOSED' (only on the actual finalize)
  //   - updated.agreementId (no agreement, nothing to email)
  //   - finalizeOwnsReservation (M2-H8 — never mail a cancelled customer)
  //   - finalizeCascadeOk (this change — never mail over a broken finalize)
  //   - the autoEmailedAt CAS inside maybeSendFinalizeEmail (never mail twice)
  //   - any throw is swallowed — an email hiccup must not break the
  //     transition response that the UI is waiting on
  if (toStep === 'CLOSED' && updated.agreementId && finalizeOwnsReservation && finalizeCascadeOk) {
    Promise.resolve()
      .then(() => maybeSendFinalizeEmail(updated, actorUserId))
      .catch((err) => {
        logger.warn('[checkout-session] auto-email-on-finalize failed', {
          sessionId: id, agreementId: updated.agreementId, error: err?.message || String(err),
        });
      });
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
 *
 * autoEmailedAt RECORDS A HAND-OFF, NOT A DELIVERY (2026-08-17). The stamp
 * lands before the scheduler is even called, and nothing clears it afterwards
 * on any path, so a stamped session is an intent marker — never proof the
 * customer holds the contract. The four things it can mean, and why the stamp
 * must stay ahead of the send, are on the column in schema.prisma.
 *
 * Note especially the case below where scheduleEmailDelivery rejects during
 * its synchronous recipient check: the stamp is already written, but the
 * background job never starts, so the audit line it would have written on
 * failure does not exist either. That case leaves nothing but the caller's
 * logger.warn — do not send a reader to the audit log for it.
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

  // RETURNED, not fired and forgotten (2026-08-17). scheduleEmailDelivery
  // validates before it schedules anything and returns a REJECTED promise when
  // it cannot resolve a recipient ("Customer email is required" — a customer
  // with no email on file is an ordinary state, not an exotic one). Detached,
  // that rejection belonged to nobody: the caller's
  // `Promise.resolve().then(...).catch(...)` only covers the chain it builds,
  // so it surfaced as an unhandled rejection instead — which under Node's
  // default `--unhandled-rejections=throw` takes the process down. It killed
  // the QA probe that found this. Returning it hands it to that catch, which
  // logs it and lets the finalize response through untouched.
  //
  // This waits on the SCHEDULING, not the delivery: past validation the real
  // work is handed to setImmediate with its own catch + audit line.
  return rentalAgreementsService.scheduleEmailDelivery(
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
async function stampSideEffect({ id, field, value, expectedVersion }) {
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
  //
  // P2 (2026-08-17): full-row read (was select:{events}) — the version check
  // needs stateVersion and, on STALE_VERSION, the whole fresh row travels in
  // the 409 body. This read-then-write is exactly the window gap #5 named;
  // expectedVersion is the opt-in guard that narrows it for new clients.
  //
  // M2-H8 (2026-08-17) — deliberately NOT given transition()'s CAS, for two
  // reasons that only show up with the code in front of you:
  //
  //   1. There is nothing sound to compare against. transition() has
  //      `currentStep`, which is the very thing it changes, so the guard is
  //      free. A stamp changes a nullable timestamp at ANY step, so the only
  //      analogous guard is `where: { [field]: null }` — and that turns every
  //      legitimate RE-stamp into a 409: the Spin webhook retrying, the
  //      customer-inspection flow restamping with an explicit `value`, an
  //      agent redoing a payment. Buying concurrency safety by breaking retry
  //      on the payment path is a bad trade nobody asked H8 to make.
  //   2. The window P2 named is still narrowed the same way it was: an opt-in
  //      caller passing expectedVersion gets STALE_VERSION here. What P2 does
  //      NOT close — and H8 does not either — is check-then-write with no
  //      lock: two stamps landing together still both commit, and the loser's
  //      `events` entry is still lost. Closing that needs row locking
  //      (SELECT … FOR UPDATE inside an interactive transaction) or moving
  //      `events` out of a TEXT column, which is its own story, not H8.
  const current = await prisma.checkoutSession.findUnique({ where: { id } });
  if (!current) throw new CheckoutSessionError('Session not found', 404);
  assertExpectedVersion(current, expectedVersion);
  return prisma.checkoutSession.update({
    where: { id },
    data: {
      [field]: at,
      stateVersion: { increment: 1 },
      events: appendEvent(current.events, {
        kind: 'SIDE_EFFECT', field, at: at.toISOString(),
      }),
    },
  });
}

/**
 * Persist the customer's final signature captured on the AGENT'S desktop
 * (Step 6 of the wizard) — the in-person counterpart to the mobile
 * inspection's signature submit. Writes the image to the agreement's
 * tcSignature* columns (same fields the PDF builder reads) and stamps
 * customerSignedAt so the wizard can advance CUSTOMER_SIGN_PENDING ->
 * FINALIZING -> CLOSED. Replaces the old "Simulate signature" stub.
 */
async function saveCustomerSignature({ id, signatureDataUrl, signerName, customerIp, expectedVersion }) {
  if (!id) throw new CheckoutSessionError('session id required', 400);
  if (!signatureDataUrl || String(signatureDataUrl).length < 200) {
    throw new CheckoutSessionError('A signature is required before finalizing.', 400, 'SIGNATURE_REQUIRED');
  }
  // P2 (2026-08-17): full-row read (was a narrow select) so the version check
  // sees stateVersion and a STALE_VERSION 409 can carry the fresh row.
  const session = await prisma.checkoutSession.findUnique({ where: { id } });
  if (!session) throw new CheckoutSessionError('Session not found', 404);
  assertExpectedVersion(session, expectedVersion);
  if (!session.agreementId) throw new CheckoutSessionError('No agreement linked to this session', 409);

  const now = new Date();
  const [, updated] = await prisma.$transaction([
    prisma.rentalAgreement.update({
      where: { id: session.agreementId },
      data: {
        tcSignatureDataUrl: signatureDataUrl,
        tcSignedAt: now,
        ...(signerName ? { tcSignerName: String(signerName).slice(0, 200) } : {}),
        ...(customerIp ? { tcCustomerIp: customerIp } : {}),
      },
    }),
    prisma.checkoutSession.update({
      where: { id },
      data: {
        customerSignedAt: now,
        stateVersion: { increment: 1 }, // P2: signature invalidates snapshots too
        events: appendEvent(session.events, {
          kind: 'CUSTOMER_SIGNED_ON_DESKTOP',
          at: now.toISOString(),
          signerName: signerName || null,
          customerIp: customerIp || null,
        }),
      },
    }),
  ]);
  return updated;
}

/**
 * Mint a single-use QR token bound to this session's reservation. The
 * customer's phone (TERMS_SIGNING) or the agent's mobile (MOBILE_INSPECTION)
 * exchanges this token at a public route to assert their session without
 * needing to log in.
 */
async function mintHandoffToken({ sessionId, kind, actorUserId }) {
  if (!sessionId) throw new CheckoutSessionError('sessionId required', 400);
  if (!['TERMS_SIGNING', 'MOBILE_INSPECTION', 'CUSTOMER_INSPECTION'].includes(kind)) {
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

  // CUSTOMER_INSPECTION links travel by email and the customer may inspect
  // hours later (decision 2026-06-11: 24h TTL, re-sendable). QR handoffs
  // stay short-lived.
  const ttlMin = kind === 'CUSTOMER_INSPECTION' ? 24 * 60 : HANDOFF_TOKEN_TTL_MIN;
  const expiresAt = new Date(Date.now() + ttlMin * 60_000);
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
      // M2 P2 review, PM decision (2026-08-17): version = MATERIAL change of
      // the session. A pause is state every other surface renders ("session
      // paused" banner), so it bumps even though no versioned stamp moved.
      stateVersion: { increment: 1 },
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
  saveCustomerSignature,
  mintHandoffToken,
  exchangeHandoffToken,
  setDeclinedInsurance,
  markAbandoned,
};
