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

export async function abandon({ id, reason, token }) {
  return api(`${BASE}/${id}/abandon`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  }, token);
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
