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
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const authToken = token || readStoredToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers, cache: 'no-store' });
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
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}
