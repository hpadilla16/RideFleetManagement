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
