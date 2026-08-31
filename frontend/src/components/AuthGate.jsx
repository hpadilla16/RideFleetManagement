'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, AUTH_EXPIRED_EVENT, PASSWORD_CHANGE_REQUIRED_EVENT, TENANT_SUSPENDED_EVENT, TOKEN_KEY, USER_KEY, clearStoredAuth } from '../lib/client';
import { TenantSuspendedHold } from './TenantSuspendedHold';

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

  // Staff 2FA (2026-08-22). The challenge token lives ONLY in component state
  // (never localStorage) — it is a 5-minute credential that grants access to
  // just the verify/enroll endpoints, and must vanish on reload.
  const [mfa, setMfa] = useState(null);            // { mode: 'VERIFY'|'ENROLL', challengeToken }
  const [mfaCode, setMfaCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [enroll, setEnroll] = useState(null);      // { qrDataUrl, secret, otpauthUri }
  const [backupCodes, setBackupCodes] = useState(null);
  const [pendingSession, setPendingSession] = useState(null); // {token,user} held until codes saved

  useEffect(() => {
    const handleAuthExpired = (event) => {
      clearStoredAuth();
      setToken('');
      setMe(null);
      setError(event?.detail?.message || 'Your session expired. Please sign in again.');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);

    // An admin reset this session's password mid-flight: the backend now
    // 403s everything with PASSWORD_CHANGE_REQUIRED. Re-fetch /me (it is on
    // the gate's allowlist) so `me.mustChangePassword` flips and the forced
    // screen renders — no manual reload needed.
    const handlePasswordChangeRequired = () => {
      api('/api/auth/me')
        .then((out) => {
          if (out?.user) {
            localStorage.setItem(USER_KEY, JSON.stringify(out.user));
            setMe(out.user);
          }
        })
        .catch(() => {});
    };
    window.addEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, handlePasswordChangeRequired);

    // Tenant Subscriptions Phase 5 (2026-08-28): the account went on hold
    // mid-session — a dunning sweep or an operator pulled the lever while
    // somebody was working. Re-fetch /me (allowlisted while suspended, exactly
    // like the password gate's) so `me.tenantStatus` flips and the hold screen
    // replaces the shell with no manual reload. The catch is deliberate: if
    // even /me is refused, the 401 path below will take over.
    const handleTenantSuspended = () => {
      api('/api/auth/me')
        .then((out) => {
          if (out?.user) {
            localStorage.setItem(USER_KEY, JSON.stringify(out.user));
            setMe(out.user);
          }
        })
        .catch(() => {});
    };
    window.addEventListener(TENANT_SUSPENDED_EVENT, handleTenantSuspended);

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
      window.removeEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, handlePasswordChangeRequired);
      window.removeEventListener(TENANT_SUSPENDED_EVENT, handleTenantSuspended);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, []);

  // Apply a full session ({token,user}) returned by login or the 2FA second
  // leg, and clear all challenge state.
  const finishAuth = (out) => {
    if (!out?.token) return;
    localStorage.setItem(TOKEN_KEY, out.token);
    localStorage.setItem(USER_KEY, JSON.stringify(out.user || {}));
    setToken(out.token);
    setMe(out.user);
    setMfa(null);
    setEnroll(null);
    setBackupCodes(null);
    setPendingSession(null);
    setMfaCode('');
    setError('');
  };

  const startEnroll = async (challengeToken) => {
    try {
      const out = await api('/api/auth/2fa/enroll/start', { method: 'POST' }, challengeToken);
      setEnroll({ qrDataUrl: out.qrDataUrl, secret: out.secret, otpauthUri: out.otpauthUri });
    } catch (e2) {
      setError(e2.message);
    }
  };

  const login = async (e) => {
    e.preventDefault();
    try {
      const out = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(form) });
      // Staff 2FA: a challenge is required before a full session is issued.
      if (out?.mfaRequired) {
        setMfa({ mode: out.mode, challengeToken: out.challengeToken });
        setMfaCode('');
        setError('');
        if (out.mode === 'ENROLL') await startEnroll(out.challengeToken);
        return;
      }
      finishAuth(out);
    } catch (e2) {
      setError(e2.message);
    }
  };

  const submitVerifyLogin = async (e) => {
    e.preventDefault();
    if (!mfa?.challengeToken) return;
    try {
      setMfaBusy(true);
      const out = await api('/api/auth/2fa/verify-login', {
        method: 'POST',
        body: JSON.stringify({ code: mfaCode.trim() })
      }, mfa.challengeToken);
      finishAuth(out);
    } catch (e2) {
      setError(e2.message);
    } finally {
      setMfaBusy(false);
    }
  };

  const submitEnrollVerify = async (e) => {
    e.preventDefault();
    if (!mfa?.challengeToken) return;
    try {
      setMfaBusy(true);
      const out = await api('/api/auth/2fa/enroll/verify', {
        method: 'POST',
        body: JSON.stringify({ code: mfaCode.trim() })
      }, mfa.challengeToken);
      // Show the one-time backup codes; hold the session until the user confirms
      // they saved them, then lift the gate.
      setBackupCodes(out.backupCodes || []);
      setPendingSession({ token: out.token, user: out.user });
      setError('');
    } catch (e2) {
      setError(e2.message);
    } finally {
      setMfaBusy(false);
    }
  };

  const confirmBackupSaved = () => {
    if (pendingSession) finishAuth(pendingSession);
  };

  const cancelMfa = () => {
    setMfa(null);
    setEnroll(null);
    setBackupCodes(null);
    setPendingSession(null);
    setMfaCode('');
    setError('');
  };

  const logout = () => {
    clearStoredAuth();
    setToken('');
    setMe(null);
  };

  // First-login onboarding (2026-07-25): while me.mustChangePassword the
  // backend 403s everything (PASSWORD_CHANGE_REQUIRED) except the
  // change-password endpoint, and this gate renders the forced screen
  // instead of the app. Success returns a fresh token+user, which lifts the
  // gate in one round trip.
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const changePassword = async (e) => {
    e.preventDefault();
    if (pwForm.next !== pwForm.confirm) {
      setError('New password and confirmation do not match');
      return;
    }
    try {
      setPwBusy(true);
      const out = await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: pwForm.current, newPassword: pwForm.next })
      });
      localStorage.setItem(TOKEN_KEY, out.token);
      localStorage.setItem(USER_KEY, JSON.stringify(out.user || {}));
      setToken(out.token);
      setMe(out.user);
      setPwForm({ current: '', next: '', confirm: '' });
      setError('');
    } catch (e2) {
      setError(e2.message);
    } finally {
      setPwBusy(false);
    }
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

  // Staff 2FA challenge (2026-08-22): password verified, full session withheld
  // until the second factor is satisfied. Rendered before the login form so the
  // user cannot fall back to it mid-challenge.
  if (mfa) {
    // One-time backup codes after a successful enrollment.
    if (backupCodes) {
      return (
        <main className="auth-wrap auth-animated-split">
          <div className="auth-purple-half" aria-hidden />
          <img src="/ride-logo.png" alt="Ride logo" className="intro-logo" />
          <div className="glass card-lg login-card centered-login login-float-in">
            <h1>Save your backup codes</h1>
            <p className="label">
              Each code works once if you lose your authenticator. Store them somewhere safe —
              they will not be shown again.
            </p>
            <div className="stack" style={{ marginTop: 12, fontFamily: 'monospace', fontSize: 16 }}>
              {backupCodes.map((c) => (<div key={c}>{c}</div>))}
            </div>
            <button type="button" style={{ marginTop: 16 }} onClick={confirmBackupSaved}>
              I saved these — continue
            </button>
          </div>
        </main>
      );
    }
    // ENROLL: show the QR + manual secret, then take a code to finish enrollment.
    if (mfa.mode === 'ENROLL') {
      return (
        <main className="auth-wrap auth-animated-split">
          <div className="auth-purple-half" aria-hidden />
          <img src="/ride-logo.png" alt="Ride logo" className="intro-logo" />
          <div className="glass card-lg login-card centered-login login-float-in">
            <h1>Set up two-factor authentication</h1>
            <p className="label">
              Your organization requires 2FA. Scan this QR code with an authenticator app
              (Google Authenticator, Authy, 1Password), then enter the 6-digit code.
            </p>
            {error ? <p className="error">{error}</p> : null}
            {enroll?.qrDataUrl ? (
              <img src={enroll.qrDataUrl} alt="2FA QR code" style={{ width: 200, height: 200, margin: '12px auto' }} />
            ) : (
              <p className="label">Preparing your enrollment…</p>
            )}
            {enroll?.secret ? (
              <p className="label">Can't scan? Enter this key manually: <code>{enroll.secret}</code></p>
            ) : null}
            <form onSubmit={submitEnrollVerify} className="stack" style={{ marginTop: 12 }}>
              <input
                placeholder="6-digit code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                required
              />
              <button type="submit" disabled={mfaBusy || !enroll?.qrDataUrl}>
                {mfaBusy ? 'Verifying…' : 'Verify and enable'}
              </button>
            </form>
            <div className="auth-legal-row">
              <button type="button" className="legal-link-inline" onClick={cancelMfa} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                Cancel
              </button>
            </div>
          </div>
        </main>
      );
    }
    // VERIFY: already enrolled — take a live TOTP or backup code.
    return (
      <main className="auth-wrap auth-animated-split">
        <div className="auth-purple-half" aria-hidden />
        <img src="/ride-logo.png" alt="Ride logo" className="intro-logo" />
        <div className="glass card-lg login-card centered-login login-float-in">
          <h1>Two-factor authentication</h1>
          <p className="label">Enter the 6-digit code from your authenticator app, or a backup code.</p>
          {error ? <p className="error">{error}</p> : null}
          <form onSubmit={submitVerifyLogin} className="stack" style={{ marginTop: 12 }}>
            <input
              placeholder="Authentication code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value)}
              required
              autoFocus
            />
            <button type="submit" disabled={mfaBusy}>{mfaBusy ? 'Verifying…' : 'Verify'}</button>
          </form>
          <div className="auth-legal-row">
            <button type="button" className="legal-link-inline" onClick={cancelMfa} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Back to sign in
            </button>
          </div>
        </div>
      </main>
    );
  }

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

  if (me?.mustChangePassword) {
    return (
      <main className="auth-wrap auth-animated-split">
        <div className="auth-purple-half" aria-hidden />
        <img src="/ride-logo.png" alt="Ride logo" className="intro-logo" />

        <div className="glass card-lg login-card centered-login login-float-in">
          <h1>Set your password</h1>
          <p className="label">
            Your account is using a temporary password. Choose your own to continue —
            at least 12 characters with uppercase, lowercase, a number, and a special character.
          </p>
          {error ? <p className="error">{error}</p> : null}

          <form onSubmit={changePassword} className="stack" style={{ marginTop: 12 }}>
            <input
              placeholder="Temporary password"
              type="password"
              autoComplete="current-password"
              value={pwForm.current}
              onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })}
              required
            />
            <input
              placeholder="New password"
              type="password"
              autoComplete="new-password"
              value={pwForm.next}
              onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })}
              required
            />
            <input
              placeholder="Confirm new password"
              type="password"
              autoComplete="new-password"
              value={pwForm.confirm}
              onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
              required
            />
            <button type="submit" disabled={pwBusy}>{pwBusy ? 'Saving…' : 'Save and continue'}</button>
          </form>

          <div className="auth-legal-row">
            <button type="button" className="legal-link-inline" onClick={logout} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              Sign out
            </button>
          </div>
        </div>
      </main>
    );
  }

  // Tenant Subscriptions Phase 5 (2026-08-28): the account is on hold. Rendered
  // LAST of the gates, and that order is the point:
  //   - the login form comes first, because somebody who is not signed in
  //     should be offered a sign-in, not a bill;
  //   - the forced password change comes first, because the backend's password
  //     gate 403s BEFORE the suspension gate, so showing the hold screen while
  //     the app is really asking for a password would send the user to fix the
  //     wrong thing.
  // KEYED ON `tenantAccessHeld`, NEVER ON `tenantStatus`. The server computes
  // it from the same environment variable the middleware reads, so with
  // enforcement off (or in log-only mode) this deploy renders nothing new —
  // which is what "ships inert" has to mean in the browser too. Keying on
  // tenantStatus would lock out every already-suspended tenant's staff the
  // moment the bundle shipped, with the backend switch still off.
  //
  // SUPER_ADMIN is excluded here as well as in the backend gate: the platform
  // owner is never held, and a super-admin looking at a suspended tenant must
  // keep the app, not inherit its hold screen.
  if (me?.tenantAccessHeld && String(me?.role || '').toUpperCase() !== 'SUPER_ADMIN') {
    return <TenantSuspendedHold me={me} logout={logout} />;
  }

  return children({ token, me, setMe, logout, setError });
}
