/**
 * Thin client wrapper around the /api/checkout-sessions endpoints. Keeps
 * the wizard UI focused on rendering while this file owns the network
 * shape + polling + transition logic.
 */

import { api } from './client';

const BASE = '/api/checkout-sessions';

export async function createSession({ reservationId, token }) {
  return api(BASE, {
    method: 'POST',
    body: JSON.stringify({ reservationId }),
  }, token);
}

export async function getSession({ id, token }) {
  return api(`${BASE}/${id}`, {}, token);
}

export async function getSessionByReservation({ reservationId, token }) {
  return api(`${BASE}/by-reservation/${reservationId}`, {}, token);
}

export async function transition({ id, toStep, metadata, token }) {
  return api(`${BASE}/${id}/transition`, {
    method: 'POST',
    body: JSON.stringify({ toStep, metadata }),
  }, token);
}

export async function stamp({ id, field, value, token }) {
  return api(`${BASE}/${id}/stamp`, {
    method: 'POST',
    body: JSON.stringify({ field, value }),
  }, token);
}

export async function mintTermsToken({ id, token }) {
  return api(`${BASE}/${id}/terms-token`, { method: 'POST' }, token);
}

export async function mintHandoffToken({ id, token }) {
  return api(`${BASE}/${id}/handoff-token`, { method: 'POST' }, token);
}

// ── Terminal contract signing (2026-09-04) ──────────────────────────────────
// Step 2 on a Dejavoo QD2. NONE of these move money: they display a clause and
// capture ink. The SERVER owns the PHONE/TERMINAL switch — getTerminalContract
// answers with `mode`, and the wizard renders the existing QR flow whenever it
// says PHONE, so a counter with no terminal can never be shown a ladder for a
// device that is not there.

export async function getTerminalContract({ id, token }) {
  return api(`${BASE}/${id}/terminal-contract`, {}, token);
}

/**
 * Put ONE clause on the terminal. Omitting sectionKey means "the next one that
 * is not yet accepted", which is what makes a resume a resume — the agent
 * screen never has to remember where it was, because the server reads it back
 * out of the database every time.
 */
export async function runTerminalClause({ id, sectionKey, token }) {
  return api(`${BASE}/${id}/terminal-contract/clause`, {
    method: 'POST',
    body: JSON.stringify({ sectionKey: sectionKey || null }),
  }, token);
}

export async function captureTerminalSignature({ id, token }) {
  return api(`${BASE}/${id}/terminal-contract/signature`, { method: 'POST' }, token);
}

/**
 * Hand the checkout to the renter's phone, carrying over the clauses they
 * already accepted on the terminal. Returns the TERMS_SIGNING token in the same
 * round trip so the QR appears immediately — the fallback is ONE action, never
 * two that can be left half-done.
 */
export async function fallbackTerminalContract({ id, reason, token }) {
  return api(`${BASE}/${id}/terminal-contract/fallback`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason || null }),
  }, token);
}

/**
 * The five verdicts, mirrored from backend/src/modules/payment-gateway/
 * terminal-state.js. A terminal fails eleven ways and the agent's correct
 * action differs in each; this is what the ladder keys its buttons off, so the
 * screen never has to parse a gateway message string.
 */
export const TERMINAL_VERDICTS = {
  WAIT: 'WAIT', RETRY: 'RETRY', FALL_BACK: 'FALL_BACK', STOP: 'STOP', CONTINUE: 'CONTINUE',
};

/**
 * Which buttons does this failure earn? Pure, so it is testable without
 * mounting the wizard — and so the rule lives in one place rather than being
 * re-derived inside three JSX branches.
 *
 * The rule: RETRY gets a resend, FALL_BACK gets the phone, WAIT gets neither
 * (the countdown is the answer), STOP gets neither because no button helps.
 * Nothing here can double-charge anyone — this step moves no money — but the
 * same shape is what the sale path needs, where offering "retry" on an
 * unresolved timeout is how a renter gets charged twice.
 */
export function terminalActionsFor(verdict) {
  switch (verdict) {
    case TERMINAL_VERDICTS.RETRY:     return { resend: true, fallback: true, wait: false };
    case TERMINAL_VERDICTS.FALL_BACK: return { resend: false, fallback: true, wait: false };
    case TERMINAL_VERDICTS.WAIT:      return { resend: false, fallback: false, wait: true };
    case TERMINAL_VERDICTS.STOP:      return { resend: false, fallback: true, wait: false };
    default:                          return { resend: true, fallback: true, wait: false };
  }
}

export async function abandon({ id, reason, token }) {
  return api(`${BASE}/${id}/abandon`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  }, token);
}

/**
 * What step 3 (PAYMENT_PENDING) should actually render.
 *
 * The wizard is server-driven — the backend owns `currentStep` and stamps
 * `paymentCompletedAt` — but PAYMENT_PENDING had its own client-side gate that
 * only knew about loaners. So a session the backend had already satisfied (the
 * new per-tenant `checkoutPaymentRequired=false` policy, or a Spin webhook that
 * landed early) still rendered the full two-tap Spin screen, and the agent had
 * to sit through a payment UI for money nobody was collecting. The auto-advance
 * effect would eventually fire off the same stamp, so this was a race the agent
 * could see and click into.
 *
 *   LOANER  — loaner check-out. FIRST, and before the stamp check on purpose:
 *             the backend pre-stamps loaners too, so testing the stamp first
 *             would swallow the CUSTOMER_PAY upgrade-differential screen the
 *             advisor still needs.
 *   SKIP    — payment already satisfied server-side. Confirm and move on.
 *   COLLECT — today's behavior: run the Spin sale + deposit hold.
 *
 * Pure so it can be tested without mounting the 2k-line wizard.
 */
export const PAYMENT_STEP_MODES = { LOANER: 'LOANER', SKIP: 'SKIP', COLLECT: 'COLLECT' };

export function paymentStepMode(session, reservation) {
  if (String(reservation?.workflowMode) === 'DEALERSHIP_LOANER') return PAYMENT_STEP_MODES.LOANER;
  if (session?.paymentCompletedAt) return PAYMENT_STEP_MODES.SKIP;
  return PAYMENT_STEP_MODES.COLLECT;
}

// CheckoutStep → display label + step number for the tracker UI.
export const STEP_INFO = {
  CONFIRMING:              { number: 1, label: 'Confirm' },
  TC_PENDING:              { number: 2, label: 'Terms' },
  TC_SIGNED:               { number: 2, label: 'Terms' },
  PAYMENT_PENDING:         { number: 3, label: 'Payment' },
  PAID:                    { number: 3, label: 'Payment' },
  INSPECTION_HANDOFF:      { number: 4, label: 'Inspection' },
  INSPECTION_IN_PROGRESS:  { number: 5, label: 'Metrics' },
  CUSTOMER_SIGN_PENDING:   { number: 6, label: 'Sign' },
  FINALIZING:              { number: 6, label: 'Sign' },
  CLOSED:                  { number: 6, label: 'Done' },
  CANCELLED:               { number: 0, label: 'Cancelled' },
};

export function stepNumber(currentStep) {
  return STEP_INFO[currentStep]?.number ?? 1;
}

export function isTerminal(currentStep) {
  return currentStep === 'CLOSED' || currentStep === 'CANCELLED';
}

// Reverse lookup — the wizard UI knows what step number it's on, but the
// backend expects the canonical CheckoutStep enum. Returns the FIRST
// enum value mapping to that step number (e.g. 2 → TC_PENDING, not
// TC_SIGNED) for forward-only transitions.
const STEP_NUMBER_TO_FIRST_STATE = {
  1: 'CONFIRMING',
  2: 'TC_PENDING',
  3: 'PAYMENT_PENDING',
  4: 'INSPECTION_HANDOFF',
  5: 'INSPECTION_IN_PROGRESS',
  6: 'CUSTOMER_SIGN_PENDING',
};

export function firstStateForStepNumber(n) {
  return STEP_NUMBER_TO_FIRST_STATE[n] || null;
}

// Forward order of CheckoutStep — used only to decide whether a 409 means
// "already there / already past it" (benign, swallow) vs a real error.
export const STEP_ORDER = [
  'CONFIRMING', 'TC_PENDING', 'TC_SIGNED', 'PAYMENT_PENDING', 'PAID',
  'INSPECTION_HANDOFF', 'INSPECTION_IN_PROGRESS', 'CUSTOMER_SIGN_PENDING',
  'FINALIZING', 'CLOSED',
];

/**
 * The 409 codes `POST /transition` can answer with that mean "your request was
 * redundant, nothing is wrong". Exhaustive against the thrown sites in
 * checkout-session.service.js#transition:
 *
 *   ILLEGAL_TRANSITION     the classic double-fire, and the "already past"
 *                          case — the step comparison below tells them apart
 *   CONCURRENT_MODIFICATION lost the CAS race three times; if the fresh row is
 *                          already at/past the step, the work did land
 *
 * Deliberately absent, and each for its own reason:
 *
 *   FINALIZE_INCOMPLETE    the session closed but the finalize did not finish
 *   STALE_VERSION          the wizard sends no expectedVersion, so reaching
 *                          this means an assumption broke — show it
 *   ENTRY_GUARD            unreachable with at >= want (the service answers
 *                          "already there" before it checks entry
 *                          requirements), so if it ever arrives here, the
 *                          service changed and the agent should hear about it
 */
const BENIGN_CONFLICT_CODES = ['ILLEGAL_TRANSITION', 'CONCURRENT_MODIFICATION'];

/**
 * Should the wizard swallow this failed transition as a benign no-op?
 *
 * Lives here, not inline in the page, because it is the rule that decides
 * whether an agent ever SEES a failure — and it needs a test.
 *
 * The step half of the rule is "the session is already at or past the step I
 * asked for, so my POST was redundant". That is right for the double-fire it
 * was written for (M2-H8 now answers most of those with a 200 anyway).
 *
 * On its own it is WRONG at the finalize, and invisibly so. Every error the
 * CLOSED cascade raises arrives AFTER the step has committed, so `at >= want`
 * is satisfied by construction and the whole class would vanish without a
 * toast — on the one error that means "this checkout is closed but its
 * finalize did not finish: the reservation is still CONFIRMED, the contract
 * still DRAFT, the car unmarked". The agent would see the finished-checkout
 * screen over exactly the broken state somebody has to fix at the counter.
 * It was also a visibility REGRESSION: those failures used to surface as 422s,
 * which fell straight through to the toast — confusing, but visible.
 * Re-labelling them 409 to give RideOps a usable code must not cost the
 * wizard the toast.
 *
 * 2026-08-17: naming the codes to swallow, instead of the one code not to,
 * is the part that makes this hold. The exemption list was a DENY-list of one
 * (FINALIZE_INCOMPLETE), which covered the self-heal path and silently missed
 * the winner path's bare VEHICLE_CONFLICT — the same broken state, a different
 * code, no toast. The backend now labels both FINALIZE_INCOMPLETE, so that
 * specific hole is closed at the source; this list is what keeps the NEXT
 * unforeseen 409 loud instead of silent. On a step that moves money, a legal
 * document and a car, an unrecognised failure is worth a toast the agent can
 * dismiss far more than it is worth a silence nobody can.
 */
export function shouldSwallowTransitionConflict({ err, fresh, toStep }) {
  if (err?.status !== 409) return false;
  if (!BENIGN_CONFLICT_CODES.includes(err?.code)) return false;
  const at = STEP_ORDER.indexOf(fresh?.currentStep);
  const want = STEP_ORDER.indexOf(toStep);
  return at !== -1 && want !== -1 && at >= want;
}


// ---------------------------------------------------------------------------
// The CLOSED screen's failure copy.
//
// Lives here, beside shouldSwallowTransitionConflict, for the same reason it
// does: this is the other half of "does the agent learn the truth?". The rule
// above decides whether the failure is SHOWN; the map below decides whether it
// is UNDERSTOOD. Both need a test, and neither belongs inline in a 2000-line
// page component.
//
// The map holds no prose — only the reasons this screen can TRANSLATE, and
// whether each one is worth offering a retry for. The strings live in
// locales/{en,es}.json under `checkoutClosed.reasons.*`, because the app boots
// in English (lib/i18n.js) and a Spanish-only failure card would be
// unreadable to half the counter. Hector's call, 2026-08-17.
//
// Keys are the `reason` member the backend hangs off FINALIZE_INCOMPLETE
// (checkout-session.service.js — `incomplete.reason = fail.code`).
// ---------------------------------------------------------------------------
export const FINALIZE_FAILURE_REASONS = {
  VEHICLE_CONFLICT: {},
  NO_VEHICLE_ASSIGNED: {},
  PRECHECKIN_REQUIRED: {},
  AGE_RULES_DOB_REQUIRED: {},
  AGE_RULES_DOB_IMPLAUSIBLE: {},
  // terminal: no amount of retrying clears an age bound, so the card must not
  // offer "Reintentar cierre" as its loud primary action.
  AGE_RULES_UNDER_MIN: { terminal: true },
  AGE_RULES_ABOVE_MAX: { terminal: true },
};

/** i18n keys for a reason the card can translate. */
export function finalizeReasonKeys(reason) {
  return {
    titleKey: `checkoutClosed.reasons.${reason}.title`,
    bodyKey: `checkoutClosed.reasons.${reason}.body`,
  };
}

/**
 * Which copy the CLOSED-but-not-finalized card should show.
 *
 * Returns KEYS, not sentences — except for the one case that must not be
 * translated at all. An unrecognised `reason` falls through to the backend's
 * OWN message, verbatim, in whatever language it wrote it: the same bet
 * BENIGN_CONFLICT_CODES makes one screen over. A `default` that swallowed an
 * unknown guard into friendly copy would be the exact failure this whole
 * ticket exists to undo — a confident screen over a state nobody described.
 * Ugly-but-true beats pretty-but-silent on a step that moves a car.
 *
 * Neither body ever says "and then retry the close". Whether a retry can even
 * work is not knowable from the reason alone — it also depends on the
 * reservation's status, which only the card can see (the backend re-runs the
 * finalize for NEW/CONFIRMED and silently declines the rest). Printing that
 * instruction beside no button, or beside one that cannot work, is the same
 * confident-but-false affordance this ticket removes. The card appends it
 * itself, only when it is actually offering one.
 *
 * No `reason` at all is the F5 case: the agent reloaded, the error object is
 * gone, and server truth still says the finalize did not finish. We say
 * exactly that and let "retry" go fetch the reason again.
 */
export function resolveFinalizeFailureCopy({ reason, message } = {}) {
  const known = reason ? FINALIZE_FAILURE_REASONS[reason] : null;
  if (known) {
    return {
      reason,
      terminal: !!known.terminal,
      translated: true,
      ...finalizeReasonKeys(reason),
      // The raw message carries specifics the map cannot — which reservation
      // holds the car, which age bound broke — so it rides along verbatim.
      detail: message || null,
      bodyText: null,
    };
  }
  return {
    reason: reason || null,
    terminal: false,
    translated: false,
    titleKey: 'checkoutClosed.genericTitle',
    // bodyText wins when present; the key is only the no-message fallback.
    bodyKey: 'checkoutClosed.genericBody',
    bodyText: message || null,
    detail: null,
  };
}

/**
 * Did the finalize actually finish?
 *
 * Extracted here, like shouldSwallowTransitionConflict above, because it is a
 * rule that decides what an agent is told — and it needs a test.
 *
 * BOTH clauses, and the second one is not decoration. The write that turns the
 * DRAFT into the legal document is deliberately best-effort in the service: it
 * catches, clears its flag, and lets the cascade finish so the vehicle sync is
 * not stranded. So a reservation can reach CHECKED_OUT with the contract still
 * DRAFT and the email withheld, while transition() answers 200 with no error.
 * Reading only reservation.status calls that a success.
 *
 * Vehicle status is deliberately NOT a third clause. syncVehicleStatusForReservation
 * SKIPS (rather than fails) a car in a locked status like IN_MAINTENANCE, so a
 * perfectly good finalize can legitimately end not-ON_RENT. A third clause
 * would manufacture false failures on healthy checkouts.
 */
export function isFinalizeComplete(reservation) {
  return String(reservation?.status) === 'CHECKED_OUT'
    && String(reservation?.rentalAgreement?.status) === 'FINALIZED';
}

/**
 * What the CLOSED failure card may offer, given server truth + the reason.
 *
 * `retryCanWork` mirrors the backend's self-heal allow-list exactly
 * (checkout-session.service.js — `selfHealOwns`). Outside it the backend
 * declines the re-run with a server-side log and a plain 200, so a retry
 * button there would be a control that silently changes nothing under copy
 * promising to explain the blocker.
 *
 * `halfFinalized` requires an agreement to EXIST. The cascade wraps its
 * agreement work in `if (updated.agreementId)`, so a session without one can
 * reach CHECKED_OUT with no contract at all — and the half-finalize copy
 * ("the contract never left draft") would be describing a document that was
 * never created.
 */
export function closedCardState({ reservation, terminalReason = false } = {}) {
  const status = String(reservation?.status || '');
  const agreementStatus = reservation?.rentalAgreement?.status || null;
  const retryCanWork = ['NEW', 'CONFIRMED'].includes(status);
  const voided = ['CANCELLED', 'NO_SHOW'].includes(status);
  const halfFinalized = status === 'CHECKED_OUT'
    && !!agreementStatus && agreementStatus !== 'FINALIZED';
  return {
    status,
    agreementStatus,
    retryCanWork,
    voided,
    halfFinalized,
    showRetry: retryCanWork && !terminalReason,
  };
}
