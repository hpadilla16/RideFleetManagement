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
    if (res.status === 401 && !tokenless) {
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

export function verifyId(sessionId, { aamvaFields, licensePhoto, selfiePhoto }) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/verify-id`, {
    method: 'POST', body: { aamvaFields, licensePhoto, selfiePhoto },
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

export function completeSession(sessionId) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/complete`, {
    method: 'POST',
  });
}

// reason must be one of the backend's canonical ESCALATE_REASONS.
export function escalateSession(sessionId, reason) {
  return kioskFetch(`/api/kiosk/sessions/${encodeURIComponent(sessionId)}/escalate`, {
    method: 'POST', body: { reason },
  });
}
