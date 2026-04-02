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
    if (configuredHost && configuredIsLocal && !currentIsLocal) {
      return origin;
    }
    if (configuredHost && !currentIsLocal && configuredHost !== currentHost) {
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
          if (j?.error) msg = j.error;
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
