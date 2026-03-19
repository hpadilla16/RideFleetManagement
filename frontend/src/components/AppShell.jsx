'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, TOKEN_KEY, USER_KEY, readStoredToken } from '../lib/client';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/reservations', label: 'Reservations' },
  { href: '/vehicles', label: 'Vehicles' },
  { href: '/customers', label: 'Customers' },
  { href: '/people', label: 'People', adminOnly: true },
  // agreements module hidden from nav (workflow moved to reservations),
  { href: '/planner', label: 'Planner' },
  { href: '/reports', label: 'Reports' },
  { href: '/car-sharing', label: 'Car Sharing', feature: 'carSharing' },
  { href: '/settings', label: 'Settings' },
  { href: '/tenants', label: 'Tenants', superOnly: true },
  { href: '/settings/security', label: 'Security', adminOnly: true }
];

const IDLE_LOCK_MS = 2 * 60 * 1000;

function formatDate(d) {
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function formatTime(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function AppShell({ me, logout, children }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return localStorage.getItem('ui.darkMode') === '1'; } catch { return false; }
  });

  const [locked, setLocked] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [newPin, setNewPin] = useState('');
  const [newPin2, setNewPin2] = useState('');
  const [lockMsg, setLockMsg] = useState('');
  const [failedUnlockAttempts, setFailedUnlockAttempts] = useState(0);
  const [now, setNow] = useState(new Date());
  const [canReturnSuper, setCanReturnSuper] = useState(false);
  const [carSharingVisible, setCarSharingVisible] = useState(() => String(me?.role || '').toUpperCase() === 'SUPER_ADMIN');

  const idleTimerRef = useRef(null);
  const role = String(me?.role || '').toUpperCase();
  const isAdminNavRole = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);

  const authApi = async (path, init = {}) => {
    const token = readStoredToken();
    if (!token) throw new Error('Missing auth token');
    const res = await fetch(`${API_BASE}/api/auth${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers || {})
      }
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
    return j;
  };

  useEffect(() => {
    try {
      setDarkMode(localStorage.getItem('ui.darkMode') === '1');
      const persistedLocked = localStorage.getItem('ui.screenLocked') === '1';
      if (persistedLocked) {
        setLocked(true);
        setNow(new Date());
      }
      // fast local hint to avoid showing first-time setup on refresh
      const hasPinHint = localStorage.getItem('ui.hasPin') === '1';
      setHasPin(hasPinHint);
      const hasBackup = !!localStorage.getItem('superadmin_backup_token');
      const role = String(me?.role || '').toUpperCase();
      setCanReturnSuper(hasBackup && role !== 'SUPER_ADMIN');
    } catch {}
    (async () => {
      try {
        const token = readStoredToken();
        if (!token) return;
        const st = await authApi('/lock-pin/status');
        const has = !!st?.hasPin;
        setHasPin(has);
        try { localStorage.setItem('ui.hasPin', has ? '1' : '0'); } catch {}
      } catch {
        setHasPin(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { localStorage.setItem('ui.darkMode', darkMode ? '1' : '0'); } catch {}
    if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  useEffect(() => {
    const role = String(me?.role || '').toUpperCase();
    if (role === 'SUPER_ADMIN') {
      setCarSharingVisible(true);
      return;
    }
    if (!['ADMIN', 'OPS'].includes(role)) {
      setCarSharingVisible(false);
      return;
    }

    (async () => {
      try {
        const token = readStoredToken();
        if (!token) return;
        const res = await fetch(`${API_BASE}/api/car-sharing/config`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
          setCarSharingVisible(false);
          return;
        }
        const json = await res.json();
        setCarSharingVisible(!!json?.enabled);
      } catch {
        setCarSharingVisible(false);
      }
    })();
  }, [me?.role]);

  useEffect(() => {
    if (!locked) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [locked]);

  const armIdleLock = useMemo(() => () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      setLocked(true);
      try { localStorage.setItem('ui.screenLocked', '1'); } catch {}
      setPinInput('');
      setLockMsg('');
      setNow(new Date());
    }, IDLE_LOCK_MS);
  }, []);

  useEffect(() => {
    if (locked) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      return;
    }
    const onActivity = () => armIdleLock();
    const evs = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    armIdleLock();
    return () => {
      evs.forEach((e) => window.removeEventListener(e, onActivity));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [locked, armIdleLock]);

  const lockNow = () => {
    setLocked(true);
    try { localStorage.setItem('ui.screenLocked', '1'); } catch {}
    setPinInput('');
    setLockMsg('');
    setFailedUnlockAttempts(0);
    setNow(new Date());
  };

  const returnToSuperAdmin = () => {
    try {
      const t = localStorage.getItem('superadmin_backup_token');
      const u = localStorage.getItem('superadmin_backup_user');
      if (!t || !u) return;
      localStorage.setItem(TOKEN_KEY, t);
      localStorage.setItem(USER_KEY, u);
      localStorage.removeItem('superadmin_backup_token');
      localStorage.removeItem('superadmin_backup_user');
      window.location.href = '/tenants';
    } catch {}
  };

  const unlock = async () => {
    try {
      if (!hasPin) {
        if (!newPin || newPin.length < 4) return setLockMsg('Set a PIN with at least 4 digits');
        if (newPin !== newPin2) return setLockMsg('PIN confirmation does not match');
        await authApi('/lock-pin/set', { method: 'POST', body: JSON.stringify({ pin: newPin }) });
        try { localStorage.setItem('ui.hasPin', '1'); } catch {}
        setHasPin(true);
        setNewPin('');
        setNewPin2('');
        setLockMsg('');
        setFailedUnlockAttempts(0);
        setLocked(false);
        try { localStorage.setItem('ui.screenLocked', '0'); } catch {}
        return;
      }

      let ok = false;
      await authApi('/lock-pin/verify', { method: 'POST', body: JSON.stringify({ pin: pinInput }) });
      ok = true;

      if (!ok) throw new Error('Invalid PIN');

      setPinInput('');
      setLockMsg('');
      setFailedUnlockAttempts(0);
      setLocked(false);
      try { localStorage.setItem('ui.screenLocked', '0'); } catch {}
    } catch (e) {
      const nextFails = failedUnlockAttempts + 1;
      setFailedUnlockAttempts(nextFails);
      if (nextFails >= 3) {
        setLockMsg('Too many failed attempts. Logging out...');
        setTimeout(() => logout(), 500);
        return;
      }
      setLockMsg(`${e.message || 'Invalid PIN'} (${nextFails}/3)`);
    }
  };

  const resetMyPin = async () => {
    try {
      await authApi('/lock-pin/reset', { method: 'POST' });
      try { localStorage.setItem('ui.hasPin', '0'); } catch {}
      setHasPin(false);
      setPinInput('');
      setNewPin('');
      setNewPin2('');
      setLockMsg('PIN reset. Set a new PIN to unlock.');
    } catch (e) {
      setLockMsg(e.message || 'Unable to reset PIN');
    }
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar glass ${mobileOpen ? 'open' : ''}`}>
        <div className="brand">Ride Fleet</div>
        <div className="stack">
          {NAV_ITEMS
            .filter((item) => !item.superOnly || String(me?.role || '').toUpperCase() === 'SUPER_ADMIN')
            .filter((item) => !item.adminOnly || isAdminNavRole)
            .filter((item) => item.feature !== 'carSharing' || carSharingVisible)
            .map((item) => (
              item.disabled ? (
                <span key={item.href} className="nav-link" style={{ opacity: .55, cursor: 'not-allowed' }}>
                  <span className="nav-label">{item.label}</span>
                </span>
              ) : (
                <Link key={item.href} href={item.href} className={`nav-link ${pathname?.startsWith(item.href) ? 'active' : ''}`} onClick={() => setMobileOpen(false)}>
                  <span className="nav-label">{item.label}</span>
                </Link>
              )
            ))}
        </div>
      </aside>

      {mobileOpen ? <div className="drawer-backdrop" onClick={() => setMobileOpen(false)} /> : null}

      <main className="content">
        <div className="topbar glass">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="mobile-menu-btn" onClick={() => setMobileOpen((v) => !v)}>☰</button>
            <div>
              <div style={{ fontWeight: 700 }}>{me?.fullName || me?.name || me?.email || 'User'}</div>
              <div className="label">{me?.role || 'ADMIN'}</div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {canReturnSuper ? <button title="Return to Super Admin" onClick={returnToSuperAdmin}>↩ Super Admin</button> : null}
            <button title="Toggle dark mode" onClick={() => setDarkMode((v) => !v)}>{darkMode ? '☀️' : '🌙'}</button>
            <button title="Lock screen" onClick={lockNow}>🔒</button>
            <button onClick={logout}>Logout</button>
          </div>
        </div>

        {children}
      </main>

      {locked ? (
        <div className="screenlock-overlay">
          <div className="screenlock-bg-orb orb-a" />
          <div className="screenlock-bg-orb orb-b" />
          <div className="screenlock-bg-orb orb-c" />

          <div className="screenlock-center">
            <div className="screenlock-logo-wrap">
              <img
                src="/logo.jpg"
                alt="Ride Fleet"
                className="screenlock-logo-img"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              <div className="screenlock-logo">Ride Fleet</div>
            </div>
            <div className="screenlock-time">{formatTime(now)}</div>
            <div className="screenlock-date">{formatDate(now)}</div>
            <div className="screenlock-user">{me?.fullName || me?.name || me?.email || 'User'}</div>

            <div className="screenlock-card glass card">
              <h3 style={{ marginBottom: 8 }}>Screen Locked</h3>
              {hasPin ? (
                <input type="password" placeholder="Enter PIN" value={pinInput} onChange={(e) => setPinInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') unlock(); }} />
              ) : (
                <div className="stack">
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>Set your unlock PIN (first time).</div>
                  <input type="password" placeholder="New PIN (min 4 digits)" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
                  <input type="password" placeholder="Confirm PIN" value={newPin2} onChange={(e) => setNewPin2(e.target.value)} />
                </div>
              )}

              {lockMsg ? <div className="label" style={{ marginTop: 8, color: '#fca5a5' }}>{lockMsg}</div> : null}

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={unlock}>Unlock</button>
                <button onClick={resetMyPin}>Reset PIN</button>
                <button onClick={logout}>Logout</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
