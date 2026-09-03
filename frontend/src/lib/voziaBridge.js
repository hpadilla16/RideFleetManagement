'use client';

/**
 * Ride Kiosk ↔ VozIA bridge helpers (B3f, 2026-07-19; F0 2026-09-03).
 * Canonical contract: voice-ai-customer-service/KIOSK-EMBED.md v4
 * (v3 = refused acks, v4 = additive kioskSessionId in kiosk-state).
 *
 * The kiosk shell talks DIRECTLY to the VozIA host with the per-conversation
 * secret it received over postMessage (CORS is VozIA's side per contract).
 * Everything here is fire-and-forget: co-presence and acks must never block
 * or break the guest wizard. NOTHING is persisted — identity lives in page
 * memory and dies with the session wipe.
 */

// Strict enums (KIOSK-EMBED.md §2) — free text gets a 400 from VozIA.
export const VOZIA_STEPS = Object.freeze([
  'find_reservation', 'verify_identity', 'license_scan', 'additional_drivers',
  'upsells', 'signature', 'payment', 'done',
]);
export const VOZIA_ERROR_CODES = Object.freeze([
  'GLARE_ERROR', 'SCAN_TIMEOUT', 'CARD_DECLINED', 'SIGNATURE_TIMEOUT', 'ID_MISMATCH', 'UNKNOWN',
]);

// Kiosk wizard screen → contract step enum. additional_drivers never applies.
//
// EVERY screen that can hold a guest while help is open must be here. The six that were missing
// (BOOT, WELCOME, ESCALATED, PAIRING, OUT_OF_SERVICE, WALKUP_SOON) made `postVoziaState` return
// early, so the agent's Kiosk tab read "no state reported" for the WHOLE session: measured
// 2026-09-03, of eleven kiosk conversations ever created only ONE ever carried a state, from the
// July E2E. A guest most naturally taps Ayuda from WELCOME, which is exactly one of the six.
//
// BOOT and WELCOME are honest funnel positions — the guest has not found their reservation yet.
// The others are NOT positions in the funnel: they are overlays that can happen at any step, so
// they map to null ON PURPOSE and `postVoziaState` reports the last real step instead of
// inventing one. Telling an agent the guest is on `find_reservation` when they escalated from
// the signature pad would be worse than telling them nothing.
const SCREEN_TO_STEP = {
  BOOT: 'find_reservation',
  WELCOME: 'find_reservation',
  LOOKUP: 'find_reservation',
  SUMMARY: 'find_reservation',
  ID: 'license_scan',
  SELFIE: 'verify_identity',
  NAME_UPDATE: 'verify_identity',
  STAFF_ASSIST: 'verify_identity',
  OFFERS: 'upsells',
  PAYMENT: 'payment',
  SIGN: 'signature',
  DONE: 'done',
};

export function voziaStepForScreen(screen) {
  return SCREEN_TO_STEP[screen] || null;
}

/**
 * The step a co-presence post should carry, given the screen and the last step already reported.
 *
 * PURE and exported ON PURPOSE: this is the rule that broke (`if (!step) return` threw the post
 * away for six of sixteen screens), and a rule that only exists inside a React callback can only
 * be tested by matching the text of page.js — a test that snaps on a reformat and, worse, can go
 * green because its pattern stopped applying. Here the behaviour tests call the SHIPPED function.
 *
 * An overlay screen (ESCALATED, PAIRING, OUT_OF_SERVICE, WALKUP_SOON) is not a position in the
 * funnel, so it repeats the last real step rather than inventing one — and with no last step it
 * returns null, because a kiosk that never got anywhere has nothing true to say.
 */
export function resolveCoPresenceStep(screenName, lastStep = null) {
  return voziaStepForScreen(screenName) || lastStep || null;
}

export function voziaOrigin(host) {
  try { return new URL(host).origin; } catch { return null; }
}

/** Iframe src per contract §URL — res omitted when no reservation attached. */
export function buildVoziaSrc({ host, widgetKey, locationId, reservationNumber }) {
  const origin = voziaOrigin(host);
  if (!origin) return null;
  const params = new URLSearchParams();
  params.set('embed', '1');
  params.set('kiosk', '1');
  if (locationId) params.set('location', String(locationId));
  if (reservationNumber) params.set('res', String(reservationNumber));
  if (widgetKey) params.set('key', String(widgetKey));
  if (typeof window !== 'undefined') params.set('parentOrigin', window.location.origin);
  return `${origin}/chat?${params.toString()}`;
}

function voziaFetch(host, path, secret, body) {
  const origin = voziaOrigin(host);
  if (!origin) return Promise.resolve(null);
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-conversation-secret': String(secret || ''),
    },
    body: JSON.stringify(body || {}),
  }).catch(() => null); // fire-and-forget by design
}

const clamp99 = (value) => Math.max(0, Math.min(99, Number(value) || 0));

/**
 * Co-presence (§2): posted by the SHELL on every step transition while a
 * conversation is active. Enums are validated here too so a mapping bug
 * degrades to "no post" instead of a 400 storm.
 *
 * `kioskSessionId` (contract v4, additive, 2026-09-03): the RFM KioskSession
 * id — the seam Valet needs to bind conversation ↔ kiosk session before any
 * remote read/write (plan MUST-CHANGE 3). Valet's validator rebuilds the
 * state object from its whitelist and IGNORES unknown fields, so sending it
 * against a v3 host is a no-op, never a 400. It is an opaque id, not PII;
 * everything else in the payload stays enum-only.
 */
export function postKioskState(host, { conversationId, secret }, { step, stepNumber, totalSteps, attempts, errorCode, kioskSessionId }) {
  if (!conversationId || !secret) return Promise.resolve(null);
  if (!VOZIA_STEPS.includes(step)) return Promise.resolve(null);
  const payload = {
    flow: 'checkin',
    step,
    stepNumber: clamp99(stepNumber),
    totalSteps: clamp99(totalSteps),
    attempts: clamp99(attempts || 1),
    ...(errorCode && VOZIA_ERROR_CODES.includes(errorCode) ? { errorCode } : {}),
    ...(kioskSessionId ? { kioskSessionId: String(kioskSessionId).slice(0, 64) } : {}),
  };
  return voziaFetch(host, `/api/conversations/${encodeURIComponent(conversationId)}/kiosk-state`, secret, payload);
}

/**
 * Command ack (§3). Unacked commands redeliver every ~2s, so a lost ack is
 * self-healing — the idempotent apply (by command.id) absorbs redelivery.
 *
 * Refusal (§3, v3): pass `{ refused: true, reason }` when the kiosk declined
 * to apply the command. A refused ack REMOVES the command from Valet's
 * pending queue exactly like a plain ack (kiosk-ack/route.ts) and appends
 * the refusal to the agent's transcript + audit — the same command id only
 * comes back if THIS ack was lost on the wire. `reason` must be enum-like
 * (no PII); it is sanitized here as a last line of defense.
 */
export function ackKioskCommand(host, { conversationId, secret }, commandId, refusal = null) {
  if (!conversationId || !secret || commandId == null) return Promise.resolve(null);
  const body = refusal?.refused
    ? { commandId, refused: true, reason: sanitizeRefusalReason(refusal.reason) }
    : { commandId };
  return voziaFetch(host, `/api/conversations/${encodeURIComponent(conversationId)}/kiosk-ack`, secret, body);
}

// ── flow_completed decision (F0, 2026-09-03) ──────────────────────────────────
//
// The agent's `flow_completed` means "the check-in is CLOSED in RFM — show the
// keys screen". The kiosk must PROVE that before changing screens: it calls
// POST /sessions/:id/complete (hard gate: checkoutSession.currentStep ===
// 'CLOSED', else 409 CHECKOUT_NOT_CLOSED) and only on success shows DONE.
// Any failure → the guest stays on the current step, the overlay/iframe stays
// mounted (unmounting it ends the conversation by contract) and the command
// is acked `refused:true` so the agent SEES the refusal. The refused ack
// clears the command from Valet's queue; the agent fixes the blocker and
// issues a NEW flow_completed. The same id is only redelivered if the ack
// was lost, and then the kiosk simply re-proves (complete() is idempotent).
//
// Kiosk-originated `reason` values (for Valet to label — KIOSK-EMBED.md v4):
//   CHECKOUT_NOT_CLOSED  server gate: checkout-session is not CLOSED yet
//                        (nothing signed / paid / keys not releasable)
//   NO_SESSION           the kiosk has no active KioskSession (WELCOME /
//                        already wiped) — nothing to complete
//   NETWORK_UNAVAILABLE  the kiosk could not reach RFM (it routes itself to
//                        OUT_OF_SERVICE)
//   DEVICE_UNPAIRED      the device token was revoked (kiosk goes to PAIRING)
//   COMPLETE_FAILED      any other failure without an enum code (5xx…)
// Any other server enum (KioskError.code) passes through verbatim.

/** Generic fallback when the failure carries no enum-like code (network, 5xx). */
export const FLOW_COMPLETED_FALLBACK_REASON = 'COMPLETE_FAILED';
const REASON_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

function sanitizeRefusalReason(reason) {
  const value = String(reason || '').trim();
  return REASON_RE.test(value) ? value : FLOW_COMPLETED_FALLBACK_REASON;
}

/**
 * Pure decision for the flow_completed ack. `ok` = completeSession resolved;
 * `errorCode` = the KioskClientError.code (server enum such as
 * CHECKOUT_NOT_CLOSED, or NETWORK_UNAVAILABLE) when it threw.
 *
 * Returns `{ refused: false }` on success; otherwise `{ refused: true, reason }`
 * with an enum-like, PII-free reason. The caller only marks the command
 * applied (idempotency set) when `refused === false`, so a redelivered id
 * (lost ack) re-proves against the server instead of being blindly acked.
 */
export function decideFlowCompletedAck({ ok, errorCode } = {}) {
  if (ok) return { refused: false };
  return { refused: true, reason: sanitizeRefusalReason(errorCode) };
}

// Kiosk wizard screen → i18n key of the step the guest still has to finish
// (the labels the ProgressSteps stepper already renders). Used to make the
// refusal toast actionable: "Todavía falta un paso (Pago)". Screens outside
// the stepper (WELCOME, DONE, ESCALATED, …) → null → generic wording.
const SCREEN_TO_STEP_KEY = {
  LOOKUP: 'kiosk.stepReservation',
  SUMMARY: 'kiosk.stepReservation',
  ID: 'kiosk.stepId',
  SELFIE: 'kiosk.stepId',
  NAME_UPDATE: 'kiosk.stepId',
  STAFF_ASSIST: 'kiosk.stepId',
  OFFERS: 'kiosk.stepExtras',
  PAYMENT: 'kiosk.stepPayment',
  SIGN: 'kiosk.stepSign',
};

export function voziaPendingStepKey(screen) {
  return SCREEN_TO_STEP_KEY[screen] || null;
}

/**
 * Redelivery-storm guard for refusals. A refused flow_completed is NOT marked
 * applied (the kiosk must re-prove on redelivery), but the guest-facing toast
 * and the session telemetry event must fire only the FIRST time per
 * `${conversationId}:${commandId}` — otherwise a lost ack + ~2s polling
 * writes an event every poll, fills eventsJson's 500-row cap in ~17 min and
 * freezes the id-photo-extract counter (429 for the guest).
 *
 * Pure over the caller-owned Set: returns true (and records the key) the
 * first time, false afterwards. Never throws on a bad key.
 */
export function noteFirstRefusal(seen, key) {
  if (!(seen instanceof Set) || key == null) return false;
  const k = String(key);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
}
