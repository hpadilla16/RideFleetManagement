function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function resolveApiBase() {
  const configured = normalizeBaseUrl(process.env.NEXT_PUBLIC_API_BASE);
  if (typeof window !== 'undefined') {
    const origin = normalizeBaseUrl(window.location.origin);
    if (!configured) return origin;
    const configuredUrl = (() => {
      try {
        return new URL(configured);
      } catch {
        return null;
      }
    })();
    const configuredHost = String(configuredUrl?.hostname || '').toLowerCase();
    const currentHost = String(window.location.hostname || '').trim().toLowerCase();
    const currentIsLocal = ['localhost', '127.0.0.1'].includes(currentHost);
    const configuredIsLocal = ['localhost', '127.0.0.1'].includes(configuredHost);

    // 2026-05-28 — Dev LAN-IP rebase.
    //
    // The agent loads the desktop wizard at e.g. http://192.168.1.42:3000
    // so the QR codes embed a phone-reachable origin. The configured API
    // base (NEXT_PUBLIC_API_BASE) is usually http://localhost:4000, which
    // the agent's phone can't reach. Detect this case and rewrite the
    // hostname to the current LAN host while preserving the configured
    // port (the backend runs on a different port from the frontend).
    if (configuredHost && configuredIsLocal && !currentIsLocal) {
      const rebuilt = new URL(configured);
      rebuilt.hostname = window.location.hostname;
      // Keep the configured port (e.g. 4000) — that's the backend port,
      // distinct from the frontend port we're currently loaded from.
      return normalizeBaseUrl(rebuilt.toString());
    }
    if (configuredHost && !currentIsLocal && configuredHost !== currentHost) {
      // Different non-local hosts (e.g. user is on ridefleetmanager.com
      // but NEXT_PUBLIC_API_BASE was baked at build time to point at
      // beta.ridefleetmanager.com). Production runs the backend behind
      // an nginx reverse proxy on the SAME hostname, so always trust
      // the current origin in this case. Reverting this to `origin`
      // restores the pre-2026-05-28 behavior — my LAN-IP rebase fix
      // mistakenly changed it to `configured`, which broke prod CORS.
      return origin;
    }
    return configured;
  }
  return configured || 'http://localhost:4000';
}

export const API_BASE = resolveApiBase();
export const TOKEN_KEY = 'fleet_jwt';
export const USER_KEY = 'fleet_user';
export const AUTH_EXPIRED_EVENT = 'ridefleet:auth-expired';
// First-login onboarding (2026-07-25): fired when the backend 403s with
// code PASSWORD_CHANGE_REQUIRED (e.g. an admin reset the password of a LIVE
// session). AuthGate listens and re-fetches /me so the forced-change screen
// appears without a manual reload.
export const PASSWORD_CHANGE_REQUIRED_EVENT = 'ridefleet:password-change-required';
// Tenant Subscriptions Phase 5 (2026-08-28): fired when the backend 403s with
// code TENANT_SUSPENDED — the tenant's account went on hold for non-payment.
// Same contract as the line above, for the same reason: a live session must be
// told WHY the app stopped working, not left with generic failures.
export const TENANT_SUSPENDED_EVENT = 'ridefleet:tenant-suspended';
// Agent Copilot Phase 1 (2026-09-01): AppShell dispatches this on every
// screen-lock change so the copilot (which mounts in the layout, OUTSIDE
// AppShell) can hide while the lock is up — the lock overlay sits at z-index
// 120, far below the copilot, so hiding is the only honest option. The flag
// key mirrors the localStorage entry AppShell already maintains; the event
// exists because same-tab localStorage writes fire no 'storage' event.
export const SCREEN_LOCK_EVENT = 'ridefleet:screen-lock';
export const SCREEN_LOCK_FLAG_KEY = 'ui.screenLocked';
const GET_CACHE_TTL_MS = 15000;
const getResponseCache = new Map();
const inflightGetRequests = new Map();

function cloneCachedValue(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {}
  }
  return value;
}

function clearGetCache() {
  getResponseCache.clear();
  inflightGetRequests.clear();
}

function buildGetCacheKey(url, token) {
  return `${url}::${String(token || '')}`;
}

// One-shot guard so the recovery reload below can never become a loop.
const VIEW_LOCATION_RECOVERY_KEY = 'ui.viewLocationRecovered';

async function parseApiResponse(res, path) {
  if (!res.ok) {
    let msg = `${path} failed (${res.status})`;
    let code = null;
    let reason = null;
    let session = null;
    try {
      const text = await res.text();
      if (text) {
        try {
          const j = JSON.parse(text);
          if (j?.error) msg = Array.isArray(j.details) && j.details.length ? j.details.join('. ') : j.error;
          else msg = `${msg}: ${text.slice(0, 300)}`;
          if (j?.code) code = String(j.code);
          // Additive members the checkout router attaches to some 409s
          // (checkout-session.routes.js:20-36). Lifted here because a caller
          // that only gets `message` has to parse prose to know what happened:
          //   reason  — the guard that actually fired behind FINALIZE_INCOMPLETE
          //   session — the fresh row on STALE_VERSION / CONCURRENT_MODIFICATION,
          //             which saves the caller a follow-up GET
          // Both stay OFF the error object on every other response, so nothing
          // else in the app changes shape. That is a claim about the two lines
          // below the `new Error`, not about these two — see there.
          if (j?.reason) reason = String(j.reason);
          if (j?.session) session = j.session;
        } catch {
          msg = `${msg}: ${text.slice(0, 300)}`;
        }
      }
    } catch {}
    const error = new Error(msg);
    error.status = res.status;
    error.code = code;
    // Guarded, like `session` right below and unlike `code` right above. This
    // is the shared error path for EVERY request in the app, so an unguarded
    // assignment would hand a `reason: null` to thousands of errors that have
    // no reason -- turning "the member is absent" into "the member is null" for
    // callers that check with `in` or `Object.keys`, and making the comment
    // above ("off the error object on every other response") false. `code` is
    // unguarded because it has always been part of this object's shape; these
    // two are additive members of a handful of checkout 409s, and the backend
    // spreads them the same way (checkout-session.routes.js: `...(err.reason ?
    // { reason: err.reason } : {})`). Symmetry with the wire is the point.
    if (reason) error.reason = reason;
    if (session) error.session = session;
    if (typeof window !== 'undefined' && res.status === 403 && code === 'PASSWORD_CHANGE_REQUIRED') {
      window.dispatchEvent(new CustomEvent(PASSWORD_CHANGE_REQUIRED_EVENT, { detail: { path } }));
    }
    // Tenant Subscriptions Phase 5 (2026-08-28): the account went on hold for
    // non-payment WHILE somebody was working. Without this the app would show a
    // wall of "could not load" banners on every panel and nothing would say
    // why — the same failure mode PASSWORD_CHANGE_REQUIRED gets this treatment
    // for. AuthGate listens, re-fetches /me (which the backend allowlists), and
    // swaps the whole shell for the hold screen.
    if (typeof window !== 'undefined' && res.status === 403 && code === 'TENANT_SUSPENDED') {
      window.dispatchEvent(new CustomEvent(TENANT_SUSPENDED_EVENT, { detail: { path } }));
    }
    // A stored location the current user does not own 403s EVERY scoped read,
    // so the app looks broken rather than mis-scoped: zeros, empty lists, and
    // "could not load" banners. It happens whenever the stored value outlives
    // the session it was chosen in — a super-admin impersonating a tenant, or
    // any user whose location assignment was changed under them. Drop it and
    // reload once; the retry sends no header and falls back to their own scope.
    if (typeof window !== 'undefined' && res.status === 403 && code === 'VIEW_LOCATION_DENIED') {
      try {
        if (readViewLocation() && !sessionStorage.getItem(VIEW_LOCATION_RECOVERY_KEY)) {
          sessionStorage.setItem(VIEW_LOCATION_RECOVERY_KEY, '1');
          writeViewLocation('');
          window.location.reload();
        }
      } catch {}
    }
    if (
      typeof window !== 'undefined' &&
      res.status === 401 &&
      readStoredToken() &&
      !String(path || '').startsWith('/api/auth/login') &&
      !String(path || '').startsWith('/api/public/')
    ) {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT, {
        detail: { path, message: msg }
      }));
    }
    throw error;
  }
  // Whatever location is stored was accepted, so re-arm the recovery guard for
  // the next time the stored value goes stale.
  if (typeof window !== 'undefined') {
    try { sessionStorage.removeItem(VIEW_LOCATION_RECOVERY_KEY); } catch {}
  }
  if (res.status === 204) return null;
  return res.json();
}

// Ride University practice mode (2026-08-16). The keys live HERE, not in
// lib/training/practice.js, because clearStoredAuth must clear them and
// practice.js already imports this module. On a shared counter PC, a logout
// that left the backup keys behind let the NEXT person who pressed "Back to
// my account" install the PREVIOUS employee's real session (QA #3) — so
// logout and auth-expiry wipe practice state along with the session.
export const PRACTICE_FLAG_KEY = 'ride-university:practice-mode';
export const PRACTICE_REAL_TOKEN_KEY = 'ride-university:real-jwt';
export const PRACTICE_REAL_USER_KEY = 'ride-university:real-user';
export const PRACTICE_REAL_VIEW_LOCATION_KEY = 'ride-university:real-view-location';

export function clearStoredAuth() {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(PRACTICE_FLAG_KEY);
    localStorage.removeItem(PRACTICE_REAL_TOKEN_KEY);
    localStorage.removeItem(PRACTICE_REAL_USER_KEY);
    localStorage.removeItem(PRACTICE_REAL_VIEW_LOCATION_KEY);
  } catch {}
}

export function readStoredToken() {
  if (typeof window === 'undefined') return '';
  return (
    localStorage.getItem(TOKEN_KEY) ||
    localStorage.getItem('token') ||
    localStorage.getItem('authToken') ||
    localStorage.getItem('accessToken') ||
    localStorage.getItem('jwt') ||
    ''
  );
}

/**
 * Serialise a request body the way every caller already assumes it is.
 *
 * `fetch` turns a plain object into the literal string "[object Object]", so
 * `api(path, { body: { addOns } })` reached the server as garbage and the
 * screen showed `"[object Object]" is not valid JSON` — which reads like a
 * server fault and is not (Rent & Go, quotes add-ons, 2026-08-20). Two call
 * sites had it; the next one would have had it too, because the correct
 * spelling (JSON.stringify) is the one you have to remember.
 *
 * So the wrapper does it. Strings pass through untouched, and the browser's
 * own body types (FormData, Blob, files, URLSearchParams) are left alone —
 * stringifying those would break uploads.
 */
export function encodeBody(body) {
  if (body === undefined || body === null) return body;
  if (typeof body === 'string') return body;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return body;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body;
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(body)) return body;
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body;
  return JSON.stringify(body);
}

export async function api(path, opts = {}, token) {
  const { cacheTtlMs, bypassCache, skipViewLocation, ...fetchOpts } = opts || {};
  const method = String(fetchOpts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) };
  const authToken = token || readStoredToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  // Location switcher (2026-08-11): every request carries the location the
  // user chose to view; requireAuth narrows their scope server-side. Opt-out
  // (skipViewLocation) exists for exactly one caller — the switcher's own
  // location list, which must stay complete or you could never switch back.
  const viewLocation = skipViewLocation ? '' : readViewLocation();
  if (viewLocation) headers['x-view-location'] = viewLocation;
  const url = `${API_BASE}${path}`;
  const useGetCache = typeof window !== 'undefined' && method === 'GET' && !bypassCache && cacheTtlMs !== 0;

  if (!useGetCache) {
    if (method !== 'GET') clearGetCache();
    const res = await fetch(url, { ...fetchOpts, method, headers, body: encodeBody(fetchOpts.body) });
    return parseApiResponse(res, path);
  }

  const now = Date.now();
  const ttlMs = Math.max(1000, Number(cacheTtlMs || GET_CACHE_TTL_MS));
  // The view location MUST be part of the cache key: without it, switching
  // locations serves the PREVIOUS location's cached lists until the TTL
  // expires — stale data wearing the new location's label.
  const cacheKey = buildGetCacheKey(`${url}||view:${viewLocation}`, authToken);
  const cached = getResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cloneCachedValue(cached.data);
  if (cached) getResponseCache.delete(cacheKey);

  const inflight = inflightGetRequests.get(cacheKey);
  if (inflight) return cloneCachedValue(await inflight);

  const requestPromise = (async () => {
    const res = await fetch(url, { ...fetchOpts, method, headers, body: encodeBody(fetchOpts.body) });
    const data = await parseApiResponse(res, path);
    getResponseCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, data: cloneCachedValue(data) });
    return data;
  })();

  inflightGetRequests.set(cacheKey, requestPromise);
  try {
    return cloneCachedValue(await requestPromise);
  } finally {
    inflightGetRequests.delete(cacheKey);
  }
}

/**
 * File downloads (PDF / XLSX / CSV) — returns the raw Response so the caller
 * can read a blob and the Content-Disposition filename.
 *
 * WHY THIS EXISTS (Hector, 2026-08-14): every export was calling fetch()
 * directly, which meant none of them sent `x-view-location`. An admin over
 * several branches who switched their view to one location saw that location
 * on screen — api() sends the header — and then exported the ENTIRE fleet,
 * because the export request arrived without it and the backend fell back to
 * the user's full location set. The screen and the spreadsheet disagreed, and
 * the spreadsheet is the one people forward.
 *
 * One definition, so a new export cannot quietly ship without the header —
 * the same reasoning as the view-location chokepoint in requireAuth.
 */
export async function apiDownload(path, opts = {}, token) {
  const { headers: extraHeaders, skipViewLocation, ...fetchOpts } = opts || {};
  const headers = { ...(extraHeaders || {}) };
  const authToken = token || readStoredToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const viewLocation = skipViewLocation ? '' : readViewLocation();
  if (viewLocation) headers['x-view-location'] = viewLocation;
  return fetch(`${API_BASE}${path}`, { ...fetchOpts, headers });
}

/** The location the user is currently viewing AS ('' = all their locations). */
export function readViewLocation() {
  try { return localStorage.getItem('ui.viewLocationId') || ''; } catch { return ''; }
}

/** Set (or clear) the viewed location. Callers reload so every page refetches. */
export function writeViewLocation(id) {
  try {
    if (id) localStorage.setItem('ui.viewLocationId', String(id));
    else localStorage.removeItem('ui.viewLocationId');
  } catch {}
  clearGetCache();
}
