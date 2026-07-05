import { clearNativeAuth } from './nativeShell';

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

async function parseApiResponse(res, path) {
  if (!res.ok) {
    let msg = `${path} failed (${res.status})`;
    try {
      const text = await res.text();
      if (text) {
        try {
          const j = JSON.parse(text);
          if (j?.error) msg = Array.isArray(j.details) && j.details.length ? j.details.join('. ') : j.error;
          else msg = `${msg}: ${text.slice(0, 300)}`;
        } catch {
          msg = `${msg}: ${text.slice(0, 300)}`;
        }
      }
    } catch {}
    const error = new Error(msg);
    error.status = res.status;
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
  if (res.status === 204) return null;
  return res.json();
}

export function clearStoredAuth() {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {}
  // Also drop the native-storage mirror (Capacitor shell); no-op on the web.
  clearNativeAuth();
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

export async function api(path, opts = {}, token) {
  const { cacheTtlMs, bypassCache, ...fetchOpts } = opts || {};
  const method = String(fetchOpts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) };
  const authToken = token || readStoredToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const url = `${API_BASE}${path}`;
  const useGetCache = typeof window !== 'undefined' && method === 'GET' && !bypassCache && cacheTtlMs !== 0;

  if (!useGetCache) {
    if (method !== 'GET') clearGetCache();
    const res = await fetch(url, { ...fetchOpts, method, headers });
    return parseApiResponse(res, path);
  }

  const now = Date.now();
  const ttlMs = Math.max(1000, Number(cacheTtlMs || GET_CACHE_TTL_MS));
  const cacheKey = buildGetCacheKey(url, authToken);
  const cached = getResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cloneCachedValue(cached.data);
  if (cached) getResponseCache.delete(cacheKey);

  const inflight = inflightGetRequests.get(cacheKey);
  if (inflight) return cloneCachedValue(await inflight);

  const requestPromise = (async () => {
    const res = await fetch(url, { ...fetchOpts, method, headers });
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
