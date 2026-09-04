'use client';

/**
 * Ride Kiosk — device API client (Fase B3b, 2026-07-05).
 * Spec: doc/kiosk-e2e-spec-2026-07-04.md · backend: backend/src/modules/kiosk/.
 *
 * EVERY kiosk-device API call goes through this module — screens never fetch
 * directly, so any backend shape tweak from review lands in exactly one file.
 *
 * Auth: the paired device token travels as X-Kiosk-Token (NOT the user JWT —
 * the kiosk is a public lobby tablet with no logged-in user). The token is
 * issued once by POST /api/kiosk/pair and stored in localStorage. A 401 on
 * any device route means the token was rotated/revoked → callers get
 * KIOSK_ERR_UNPAIRED (storage already cleared) and must return to pairing.
 * A network failure surfaces as KIOSK_ERR_NETWORK → out-of-service screen.
 */

import { API_BASE } from './client';

const DEVICE_TOKEN_KEY = 'ride_kiosk_device_token';
const DEVICE_INFO_KEY = 'ride_kiosk_device';
export const KIOSK_APP_VERSION = 'kiosk-web/1.0.0';

export const KIOSK_ERR_NETWORK = 'NETWORK_UNAVAILABLE';
export const KIOSK_ERR_UNPAIRED = 'DEVICE_UNPAIRED';

export class KioskClientError extends Error {
  constructor(message, { status = 0, code = null, data = null } = {}) {
    super(message);
    this.name = 'KioskClientError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export function readDeviceToken() {
  if (typeof window === 'undefined') return '';
  try { return window.localStorage.getItem(DEVICE_TOKEN_KEY) || ''; } catch { return ''; }
}

export function readDeviceInfo() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DEVICE_INFO_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function storeDevice({ deviceToken, device }) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEVICE_TOKEN_KEY, String(deviceToken || ''));
    window.localStorage.setItem(DEVICE_INFO_KEY, JSON.stringify(device || {}));
  } catch {}
}

export function clearDevice() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DEVICE_TOKEN_KEY);
    window.localStorage.removeItem(DEVICE_INFO_KEY);
  } catch {}
}

async function kioskFetch(path, { method = 'GET', body, tokenless = false } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Kiosk-App-Version': KIOSK_APP_VERSION,
  };
  if (!tokenless) {
    const token = readDeviceToken();
    if (!token) throw new KioskClientError('Kiosk is not paired', { status: 401, code: KIOSK_ERR_UNPAIRED });
    headers['X-Kiosk-Token'] = token;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new KioskClientError('Network unavailable', { status: 0, code: KIOSK_ERR_NETWORK });
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok) {
    // 401 handling is an explicit ALLOWLIST: only the codes below are
    // application-level 401s that surface as normal errors (a wrong staff
    // PIN in B3c / a wrong name-update verification code in B3e must never
    // wipe the pairing). Everything else — including the device-auth
    // middleware's code-less 401 AND any future middleware 401 that grows a
    // code — still unpairs, because only allowlisted codes pass through.
    // Fail-closed by design.
    const APP_LEVEL_401 = ['INVALID_PIN', 'INVALID_CODE'];
    if (res.status === 401 && !tokenless && !APP_LEVEL_401.includes(data?.code)) {
      // Rotated / revoked / never-paired token → wipe and force re-pairing.
      clearDevice();
      throw new KioskClientError(data?.error || 'Device token rejected', {
        status: 401, code: KIOSK_ERR_UNPAIRED, data,
      });
    }
    throw new KioskClientError(data?.error || `Request failed (${res.status})`, {
      status: res.status, code: data?.code || null, data,
    });
  }
  return data;
}

// ── Pairing ──────────────────────────────────────────────────────────────────

export async function pairDevice(pairingCode) {
  const out = await kioskFetch('/api/kiosk/pair', {
    method: 'POST', body: { pairingCode }, tokenless: true,
  });
  if (out?.deviceToken) storeDevice(out);
  return out;
}

/**
 * GET /api/kiosk/device — own-device view + location {id, name} (null-safe).
 * Called on shell boot to refresh the header ("Orlando — MCO · Kiosk 1") and
 * pick up walkupEnabled changes without re-pairing. A 401 still means
 * unpaired (kioskFetch already cleared storage). The refreshed info is
 * persisted alongside the token.
 */
export async function refreshOwnDevice() {
  const out = await kioskFetch('/api/kiosk/device');
  if (out?.device && typeof window !== 'undefined') {
    try { window.localStorage.setItem(DEVICE_INFO_KEY, JSON.stringify(out.device)); } catch {}
  }
  return out?.device || null;
}

// ── Session lifecycle ────────────────────────────────────────────────────────

export function createSession(kind) {
  return kioskFetch('/api/kiosk/sessions', { method: 'POST', body: { kind } });
}

/**
 * Fire-and-forget funnel telemetry (batch ok). Never throws — a dead
 * telemetry write must not interrupt a customer mid-checkout. NOTE: the
 * offer shown/accepted/declined events are recorded SERVER-side by the
 * offers endpoints; the client only reports step transitions + UI events.
 */
export function sendEvents(sessionId, events) {
  if (!sessionId) return Promise.resolve(null);
  const list = (Array.isArray(events) ? events : [events]).filter((e) => e && e.event);
  if (!list.length) return Promise.resolve(null);
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: 'POST', body: { events: list },
  }).catch(() => null);
}

export function lookupReservation(sessionId, payload) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/lookup`, {
    method: 'POST', body: payload,
  });
}

export function attachReservation(sessionId, reservationId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/attach-reservation`, {
    method: 'POST', body: { reservationId },
  });
}

export function assignVehicle(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/assign-vehicle`, {
    method: 'POST',
  });
}

/**
 * B3d primary ID path: POST /api/kiosk/sessions/:id/id-photo-extract {photo}
 * → { fields: {firstName,lastName,dateOfBirth,licenseNumber,licenseState,
 * licenseExpiry}, warnings } — server-side OCR of the ID FRONT photo.
 * Errors: 429 EXTRACT_LIMIT (+escalateSuggested), 503 OCR_UNAVAILABLE
 * (→ barcode fallback), 422 INVALID_PHOTO (→ retake). NOTE: endpoint is being
 * built in parallel — a 404 from an older backend is treated by the caller
 * exactly like OCR_UNAVAILABLE (scanner fallback), so the UI degrades safely.
 */
export function idPhotoExtract(sessionId, photo) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/id-photo-extract`, {
    method: 'POST', body: { photo },
  });
}

export function verifyId(sessionId, { aamvaFields, licensePhoto, selfiePhoto }) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/verify-id`, {
    method: 'POST', body: { aamvaFields, licensePhoto, selfiePhoto },
  });
}

// ── B3c Staff Assist (K-S1..S3) ──────────────────────────────────────────────
// Staff authenticates AT the kiosk with their existing lock-PIN → audited
// bypass of the ID SCAN only (age/expiry rules still run server-side).

// GET → { staff: [{id, name, hasPin}] }; 409 NOT_ASSISTABLE unless the
// session is ESCALATED or carries ≥2 verify failures.
export function staffAssistList(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/staff-assist/staff`);
}

// POST {userId, pin} → { ok, grant: {userId, name, expiresAt} } (10-min TTL).
// Errors: 401 INVALID_PIN (+attemptsRemaining), 429 STAFF_ASSIST_LOCKED
// (shared with the lookup lockout), 409 NO_PIN_SET, 404 STAFF_NOT_FOUND.
export function staffAssistUnlock(sessionId, { userId, pin }) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/staff-assist/unlock`, {
    method: 'POST', body: { userId, pin },
  });
}

// POST {fields, licenseFrontPhoto, licenseBackPhoto} (BOTH photos mandatory)
// → { verified, checks, failureReasons, minimumAge, maximumAge, session }.
// Errors: 403 ASSIST_GRANT_REQUIRED (grant absent/expired), 422
// MISSING_PHOTO / INVALID_PHOTO. Failures mirror the guest verify shape.
export function staffAssistVerifyId(sessionId, { fields, licenseFrontPhoto, licenseBackPhoto }) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/staff-assist/verify-id`, {
    method: 'POST', body: { fields, licenseFrontPhoto, licenseBackPhoto },
  });
}

// ── B3e Name-mismatch: self-service code + staff light bypass ────────────────
// Layer 1 (token-subset matcher) lives server-side, so these only fire on
// REAL mismatches. Fields are ALWAYS the session's OCR-confirmed values —
// never guest free text.

// POST → { ok, sent: {email: "m•••@…", sms: "•••1234"|null}, expiresInMinutes }.
// Errors: 409 NAME_UPDATE_NOT_ELIGIBLE (name must be the ONLY failed rule),
// 422 NO_RESERVATION_ATTACHED, 429 NAME_UPDATE_LOCKED (shared device lockout).
export function nameUpdateSendCode(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/name-update/send-code`, {
    method: 'POST',
  });
}

// GET → { email: "h•••@gmail.com"|null, sms: "•••4821"|null } — MASKS only,
// gated server-side on the recorded name mismatch. Pre-send preview so the
// guest can bail out before a code fires ("someone booked for me" case).
export function nameUpdateDestinations(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/name-update/destinations`);
}

// POST {code, fields, licensePhoto?} → verify-id-shaped response (+session).
// Errors: 401 INVALID_CODE (+attemptsRemaining → 429 NAME_UPDATE_LOCKED),
// 410 CODE_EXPIRED, 409 CODE_NOT_SENT. Age/expiry rules stay hard stops.
export function nameUpdateConfirm(sessionId, { code, fields, licensePhoto }) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/name-update/confirm`, {
    method: 'POST', body: { code, fields, licensePhoto },
  });
}

// POST {fields, licensePhoto?} — staff attests the physical license matches
// the guest (no manual re-entry, no re-photos). Same shape as staff
// verify-id; 403 ASSIST_GRANT_REQUIRED without a live unlock grant.
export function staffAssistConfirmName(sessionId, { fields, licensePhoto }) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/staff-assist/confirm-name`, {
    method: 'POST', body: { fields, licensePhoto },
  });
}

export function getOffers(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/offers`);
}

export function acceptOffers(sessionId, acceptedServiceIds) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/offers`, {
    method: 'POST', body: { acceptedServiceIds },
  });
}

export function getAgreement(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/agreement`);
}

export function signAgreement(sessionId, { sectionInitials, signature, signerName }) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/sign`, {
    method: 'POST', body: { sectionInitials, signature, signerName },
  });
}

// B3 DEMO ONLY — 403 SANDBOX_DISABLED unless the backend runs with
// KIOSK_PAYMENT_SANDBOX=true. Replaced wholesale by the B5 payment-link flow.
export function sandboxPayment(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/sandbox-payment`, {
    method: 'POST',
  });
}

// What the guest is told while someone is helping them from somewhere else. Read
// from the server's own grant columns — never from what the Valet iframe claims,
// because the kiosk must not tell a guest something about their own check-in that
// the server does not believe.
export function getAssistState(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/assist-state`);
}

// B5 Phase 2 — mint (or REUSE) the tenant's own hosted payment page for this
// session and get back the URL the kiosk renders as a link and a QR. The guest
// pays on their own phone; no card data ever touches the tablet. Retrying at
// the SAME amount returns the SAME stored link — nothing is minted, so there is
// never a second live link for one guest (two links mean two real charges). If
// the balance moved, the server supersedes the intent and mints fresh, and the
// old link stays resolvable in case it is paid late.
export function createPaymentLink(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/payment-link`, {
    method: 'POST',
  });
}

export function completeSession(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/complete`, {
    method: 'POST',
  });
}

/**
 * F1 remote assist (2026-09-03): bind the session to the Valet conversation
 * the shell received over postMessage, so the agent's service account can
 * read this session's assist-view (RFM 404s any read without a matching
 * conversationId). Persists the id ONLY — the secret never leaves page
 * memory. `null` clears the binding (iframe reset/close). Fire-and-forget
 * like sendEvents: never throws, never blocks the guest wizard.
 */
export function bindVoziaConversation(sessionId, conversationId) {
  if (!sessionId) return Promise.resolve(null);
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/vozia-conversation`, {
    method: 'POST', body: { conversationId: conversationId || null },
  }).catch(() => null);
}

// reason must be one of the backend's canonical ESCALATE_REASONS.
export function escalateSession(sessionId, reason) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/escalate`, {
    method: 'POST', body: { reason },
  });
}
