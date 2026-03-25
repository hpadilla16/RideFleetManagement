'use client';

import { useEffect, useState } from 'react';
import { api, TOKEN_KEY, USER_KEY } from '../lib/client';

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
        .catch(() => {});
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
          <p className="label">Guest booking, host operations, and staff access in one app.</p>
          {error ? <p className="error">{error}</p> : null}
          <div className="hero-meta" style={{ justifyContent: 'center', marginTop: 8 }}>
            <button type="button" className={guestMode === 'signin' ? '' : 'button-subtle'} onClick={() => setGuestMode('signin')}>Guest Sign In</button>
            <button type="button" className={guestMode === 'signup' ? '' : 'button-subtle'} onClick={() => setGuestMode('signup')}>Guest Sign Up</button>
            <button type="button" className={guestMode === 'staff' ? '' : 'button-subtle'} onClick={() => setGuestMode('staff')}>Staff Login</button>
          </div>

          {guestMode !== 'staff' ? (
            <div className="surface-note" style={{ textAlign: 'left', marginTop: 12 }}>
              Guest accounts can only use the marketplace and guest portal: search vehicles, make bookings, view reservations, and manage trip steps.
            </div>
          ) : null}

          {guestMsg ? <div className="surface-note" style={{ color: /sent|created|ready|continue/i.test(guestMsg) ? '#166534' : '#991b1b', textAlign: 'left' }}>{guestMsg}</div> : null}

          {guestMode === 'signin' ? (
            <form onSubmit={requestGuestSignIn} className="stack">
              <input placeholder="Guest email" type="email" value={guestSignInEmail} onChange={(e) => setGuestSignInEmail(e.target.value)} required />
              <button type="submit" disabled={guestLoading}>{guestLoading ? 'Sending...' : 'Send Guest Sign-In Link'}</button>
              <div className="inline-actions" style={{ justifyContent: 'center' }}>
                <button type="button" className="button-subtle" onClick={() => { window.location.href = '/guest'; }}>Open Guest Portal</button>
                <button type="button" className="button-subtle" onClick={() => { window.location.href = '/book'; }}>Browse Marketplace</button>
              </div>
            </form>
          ) : null}

          {guestMode === 'signup' ? (
            <form onSubmit={createGuestAccount} className="stack">
              <div className="form-grid-2">
                <input placeholder="First name" value={guestSignUp.firstName} onChange={(e) => setGuestSignUp({ ...guestSignUp, firstName: e.target.value })} required />
                <input placeholder="Last name" value={guestSignUp.lastName} onChange={(e) => setGuestSignUp({ ...guestSignUp, lastName: e.target.value })} required />
                <input placeholder="Email" type="email" value={guestSignUp.email} onChange={(e) => setGuestSignUp({ ...guestSignUp, email: e.target.value })} required />
                <input placeholder="Phone" value={guestSignUp.phone} onChange={(e) => setGuestSignUp({ ...guestSignUp, phone: e.target.value })} required />
              </div>
              <button type="submit" disabled={guestLoading}>{guestLoading ? 'Creating...' : 'Create Guest Account'}</button>
              <div className="inline-actions" style={{ justifyContent: 'center' }}>
                <button type="button" className="button-subtle" onClick={() => { window.location.href = '/book'; }}>Browse Marketplace</button>
              </div>
            </form>
          ) : null}

          {guestMode === 'staff' ? (
            <form onSubmit={login} className="stack">
              <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              <input placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
              <button type="submit">Login</button>
            </form>
          ) : null}
        </div>
      </main>
    );
  }

  return children({ token, me, setMe, logout, setError });
}
