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

// ---------------------------------------------------------------------------
// The CLOSED screen's failure copy.
//
// Lives here, beside shouldSwallowTransitionConflict, for the same reason it
// does: this is the other half of "does the agent learn the truth?". The rule
// above decides whether the failure is SHOWN; the map below decides whether it
// is UNDERSTOOD. Both need a test, and neither belongs inline in a 2000-line
// page component.
//
// Spanish and frontend-owned on purpose. The backend message is the RideOps
// contract (ops-app-plan/docs/00-domain-workflows.md §1.4-bis) and is not ours
// to reword — it is also English, and it names a recovery the wizard does not
// have: "(or swap vehicles)" is dead at CLOSED, where `swapLocked` blocks the
// button and reservations.service.js#swapVehicle demands CHECKED_OUT anyway.
// So we translate INTENT here and keep the raw message as a technical detail
// line, rather than editing prose four other surfaces depend on.
//
// Keys are the `reason` member the backend hangs off FINALIZE_INCOMPLETE
// (checkout-session.service.js — `incomplete.reason = fail.code`).
// ---------------------------------------------------------------------------
export const FINALIZE_FAILURE_COPY = {
  VEHICLE_CONFLICT: {
    title: 'El vehículo sigue rentado en otra reservación',
    body: 'La unidad asignada no se pudo entregar porque sigue fuera en otra renta. '
      + 'Completa el check-in de esa renta y vuelve a intentar el cierre.',
  },
  NO_VEHICLE_ASSIGNED: {
    title: 'La reservación se quedó sin vehículo',
    body: 'No se puede cerrar un checkout sin unidad asignada. Asigna un vehículo desde la '
      + 'reservación y vuelve a intentar el cierre.',
  },
  PRECHECKIN_REQUIRED: {
    title: 'Falta el pre-check-in del cliente',
    body: 'Esta sede exige el pre-check-in completo. Complétalo desde la reservación '
      + '("llenar por el cliente") o reenvíale el enlace, y vuelve a intentar el cierre.',
  },
  AGE_RULES_DOB_REQUIRED: {
    title: 'Falta la fecha de nacimiento del conductor',
    body: 'Esta sede exige verificar la edad antes de entregar. Captura la fecha de nacimiento '
      + 'del ID o licencia en la reservación y vuelve a intentar el cierre.',
  },
  AGE_RULES_DOB_IMPLAUSIBLE: {
    title: 'La fecha de nacimiento es inválida',
    body: 'La fecha registrada es imposible. Corrígela con el ID o licencia del cliente y vuelve '
      + 'a intentar el cierre.',
  },
  AGE_RULES_UNDER_MIN: {
    title: 'El conductor no llega a la edad mínima',
    body: 'Esta sede no permite entregar a este conductor. El cierre no se puede completar: '
      + 'escala con tu supervisor antes de entregar la unidad.',
  },
  AGE_RULES_ABOVE_MAX: {
    title: 'El conductor excede la edad máxima',
    body: 'Esta sede no permite entregar a este conductor. El cierre no se puede completar: '
      + 'escala con tu supervisor antes de entregar la unidad.',
  },
};

/**
 * Copy for the CLOSED-but-not-finalized card.
 *
 * The fallback is the point, not an afterthought. An unrecognised `reason`
 * falls through to the backend's OWN message, untranslated — the same bet
 * BENIGN_CONFLICT_CODES makes one screen over. A `default` that swallowed an
 * unknown guard into friendly Spanish would be the exact failure this whole
 * ticket exists to undo: a confident screen over a state nobody described.
 * Ugly-but-true beats pretty-but-silent on a step that moves a car.
 *
 * `message` alone (no reason) is the F5 case: the agent reloaded, the error
 * object is gone, and server truth still says the finalize did not finish. We
 * say exactly that and let "Reintentar cierre" go fetch the reason again.
 */
export function resolveFinalizeFailureCopy({ reason, message } = {}) {
  const known = reason ? FINALIZE_FAILURE_COPY[reason] : null;
  if (known) {
    // The raw message carries specifics the map cannot — which reservation
    // holds the car, which age bound was crossed — so it rides along as a
    // detail line instead of being dropped.
    return { ...known, detail: message || null, reason: reason || null, translated: true };
  }
  return {
    title: 'El cierre no se completó',
    body: message
      || 'El checkout quedó cerrado, pero el finalize no terminó. Reintenta el cierre para ver '
        + 'qué lo está bloqueando.',
    detail: null,
    reason: reason || null,
    translated: false,
  };
}
