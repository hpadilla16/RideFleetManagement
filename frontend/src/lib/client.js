export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000';
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
