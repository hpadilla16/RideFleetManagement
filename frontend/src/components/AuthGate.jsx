'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, AUTH_EXPIRED_EVENT, TOKEN_KEY, USER_KEY, clearStoredAuth } from '../lib/client';

function parseJwt(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function AuthGate({ children }) {
  const [token, setToken] = useState('');
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ email: '', password: '' });
  const [guestMode, setGuestMode] = useState('signin');
  const [guestLoading, setGuestLoading] = useState(false);
  const [guestMsg, setGuestMsg] = useState('');
  const [guestSignInEmail, setGuestSignInEmail] = useState('');
  const [guestSignUp, setGuestSignUp] = useState({ firstName: '', lastName: '', email: '', phone: '' });

  useEffect(() => {
    const handleAuthExpired = (event) => {
      clearStoredAuth();
      setToken('');
      setMe(null);
      setError(event?.detail?.message || 'Your session expired. Please sign in again.');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);

    const t = localStorage.getItem(TOKEN_KEY) || '';
    const rawUser = localStorage.getItem(USER_KEY);
    setToken(t);
    if (rawUser) {
      try { setMe(JSON.parse(rawUser)); } catch {}
    } else if (t) {
      const claims = parseJwt(t);
      if (claims) {
        const fallback = { email: claims.email, fullName: claims.fullName || claims.name || claims.email || 'User', role: claims.role || 'AGENT' };
        setMe(fallback);
        localStorage.setItem(USER_KEY, JSON.stringify(fallback));
      }
    }

    if (t) {
      api('/api/auth/me')
        .then((out) => {
          if (out?.user) {
            localStorage.setItem(USER_KEY, JSON.stringify(out.user));
            setMe(out.user);
          }
        })
        .catch((err) => {
          if (err?.status === 401) handleAuthExpired({ detail: { message: 'Your session expired. Please sign in again.' } });
        });
    }
    // Auto-refresh token before expiry
    let refreshTimer;
    if (t) {
      const claims = parseJwt(t);
      if (claims?.exp) {
        const expiresInMs = (claims.exp * 1000) - Date.now();
        const refreshInMs = Math.max(expiresInMs - (5 * 60 * 1000), 30 * 1000); // 5 min before expiry, min 30s
        refreshTimer = setTimeout(async () => {
          try {
            const out = await api('/api/auth/refresh', { method: 'POST' });
            if (out?.token) {
              localStorage.setItem(TOKEN_KEY, out.token);
              if (out.user) localStorage.setItem(USER_KEY, JSON.stringify(out.user));
              setToken(out.token);
              if (out.user) setMe(out.user);
            }
          } catch {
            // Refresh failed — token will expire naturally and trigger auth expired
          }
        }, refreshInMs);
      }
    }

    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, []);

  const login = async (e) => {
    e.preventDefault();
    try {
      const out = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(form) });
      localStorage.setItem(TOKEN_KEY, out.token);
      localStorage.setItem(USER_KEY, JSON.stringify(out.user || {}));
      setToken(out.token);
      setMe(out.user);
      setError('');
    } catch (e2) {
      setError(e2.message);
    }
  };

  const logout = () => {
    clearStoredAuth();
    setToken('');
    setMe(null);
  };

  const requestGuestSignIn = async (e) => {
    e.preventDefault();
    try {
      setGuestLoading(true);
      const out = await api('/api/public/booking/guest-signin/request', {
        method: 'POST',
        body: JSON.stringify({ email: guestSignInEmail })
      });
      setGuestMsg(`We sent a guest sign-in link to ${out.email}. Open that email on this phone to enter your guest account.`);
      setError('');
    } catch (e2) {
      setGuestMsg(e2.message);
    } finally {
      setGuestLoading(false);
    }
  };

  const createGuestAccount = async (e) => {
    e.preventDefault();
    try {
      setGuestLoading(true);
      const out = await api('/api/public/booking/guest-signup', {
        method: 'POST',
        body: JSON.stringify(guestSignUp)
      });
      setGuestMsg(`Guest account created. We sent a sign-in link to ${out.email}. Open that email to continue.`);
      setGuestSignInEmail(guestSignUp.email);
      setGuestMode('signin');
      setError('');
    } catch (e2) {
      setGuestMsg(e2.message);
    } finally {
      setGuestLoading(false);
    }
  };

  if (!token) {
    return (
      <main className="auth-wrap auth-animated-split">
        <div className="auth-purple-half" aria-hidden />
        <img src="/ride-logo.png" alt="Ride logo" className="intro-logo" />

        <div className="glass card-lg login-card centered-login login-float-in">
          <h1>Ride Fleet</h1>
          <p className="label">Staff and operations access.</p>
          {error ? <p className="error">{error}</p> : null}

          <form onSubmit={login} className="stack" style={{ marginTop: 12 }}>
            <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            <input placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            <button type="submit">Login</button>
          </form>

          <div className="auth-legal-row">
            <span className="ui-muted">By using Ride Fleet, you agree to the current platform policies.</span>
            <Link href="/privacy" className="legal-link-inline">Privacy Policy</Link>
          </div>
        </div>
      </main>
    );
  }

  return children({ token, me, setMe, logout, setError });
}
