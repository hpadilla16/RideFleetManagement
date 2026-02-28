'use client';

import { useEffect, useState } from 'react';
import { api, TOKEN_KEY } from '../lib/client';

const USER_KEY = 'fleet_user';

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

  useEffect(() => {
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
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken('');
    setMe(null);
  };

  if (!token) {
    return (
      <main className="auth-wrap auth-animated-split">
        <div className="auth-purple-half" aria-hidden />
        <img src="/ride-logo.png" alt="Ride logo" className="intro-logo" />

        <div className="glass card-lg login-card centered-login login-float-in">
          <h1>Fleet Management</h1>
          <p className="label">Fast lane, bold ride.</p>
          {error ? <p className="error">{error}</p> : null}
          <form onSubmit={login} className="stack">
            <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            <input placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
            <button type="submit">Login</button>
          </form>
        </div>
      </main>
    );
  }

  return children({ token, me, setMe, logout, setError });
}
