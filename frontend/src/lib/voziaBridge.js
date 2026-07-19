'use client';

/**
 * Ride Kiosk ↔ VozIA bridge helpers (B3f, 2026-07-19).
 * Canonical contract: voice-ai-customer-service/KIOSK-EMBED.md v2.
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
const SCREEN_TO_STEP = {
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
 */
export function postKioskState(host, { conversationId, secret }, { step, stepNumber, totalSteps, attempts, errorCode }) {
  if (!conversationId || !secret) return Promise.resolve(null);
  if (!VOZIA_STEPS.includes(step)) return Promise.resolve(null);
  const payload = {
    flow: 'checkin',
    step,
    stepNumber: clamp99(stepNumber),
    totalSteps: clamp99(totalSteps),
    attempts: clamp99(attempts || 1),
    ...(errorCode && VOZIA_ERROR_CODES.includes(errorCode) ? { errorCode } : {}),
  };
  return voziaFetch(host, `/api/conversations/${encodeURIComponent(conversationId)}/kiosk-state`, secret, payload);
}

/**
 * Command ack (§3). Unacked commands redeliver every ~2s, so a lost ack is
 * self-healing — the idempotent apply (by command.id) absorbs redelivery.
 */
export function ackKioskCommand(host, { conversationId, secret }, commandId) {
  if (!conversationId || !secret || commandId == null) return Promise.resolve(null);
  return voziaFetch(host, `/api/conversations/${encodeURIComponent(conversationId)}/kiosk-ack`, secret, { commandId });
}
