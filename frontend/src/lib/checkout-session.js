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
