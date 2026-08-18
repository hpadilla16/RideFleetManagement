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
 * Should the wizard swallow this failed transition as a benign no-op?
 *
 * Lives here, not inline in the page, because it is the rule that decides
 * whether an agent ever SEES a failure — and it needs a test.
 *
 * The rule is "the session is already at or past the step I asked for, so my
 * POST was redundant". That is right for the double-fire it was written for
 * (M2-H8 now answers most of those with a 200 anyway).
 *
 * It is WRONG for FINALIZE_INCOMPLETE, and invisibly so. That code is raised
 * only when the session is already AT toStep, so `at >= want` is satisfied by
 * construction — every one of them would be swallowed silently, on the one
 * error that means "this checkout is closed but its finalize did not finish:
 * the reservation is still CONFIRMED, the contract still DRAFT, the car
 * unmarked". The agent would see the finished-checkout screen over exactly the
 * broken state somebody has to fix at the counter. It was also a visibility
 * REGRESSION: the underlying failures (NO_VEHICLE_ASSIGNED, PRECHECKIN_REQUIRED,
 * AGE_RULES_*) used to surface as 422s, which fell straight through to the
 * toast — confusing, but visible. Re-labelling them 409 to give RideOps a
 * usable code must not cost the wizard the toast.
 */
export function shouldSwallowTransitionConflict({ err, fresh, toStep }) {
  if (err?.status !== 409) return false;
  if (err?.code === 'FINALIZE_INCOMPLETE') return false;
  const at = STEP_ORDER.indexOf(fresh?.currentStep);
  const want = STEP_ORDER.indexOf(toStep);
  return at !== -1 && want !== -1 && at >= want;
}
