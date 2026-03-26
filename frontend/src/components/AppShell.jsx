'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, TOKEN_KEY, USER_KEY, readStoredToken } from '../lib/client';
import { isModuleEnabled, pathnameToModule } from '../lib/moduleAccess';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', moduleKey: 'dashboard' },
  { href: '/reservations', label: 'Reservations', moduleKey: 'reservations' },
  { href: '/vehicles', label: 'Vehicles', moduleKey: 'vehicles' },
  { href: '/customers', label: 'Customers', moduleKey: 'customers' },
  { href: '/people', label: 'People', adminOnly: true, moduleKey: 'people' },
  { href: '/planner', label: 'Planner', moduleKey: 'planner' },
  { href: '/reports', label: 'Reports', moduleKey: 'reports' },
  { href: '/car-sharing', label: 'Car Sharing', feature: 'carSharing', moduleKey: 'carSharing' },
  { href: '/host', label: 'Host App', feature: 'carSharing', moduleKey: 'hostApp' },
  { href: '/employee', label: 'Employee App', moduleKey: 'employeeApp' },
  { href: '/issues', label: 'Issue Center', moduleKey: 'issueCenter' },
  { href: '/loaner', label: 'Loaner Program', feature: 'dealershipLoaner', moduleKey: 'loaner' },
  { href: '/tolls', label: 'Tolls', moduleKey: 'tolls' },
  { href: '/knowledge-base', label: 'Knowledge Base' },
  { href: '/settings', label: 'Settings', moduleKey: 'settings' },
  { href: '/tenants', label: 'Tenants', superOnly: true, moduleKey: 'tenants' },
  { href: '/settings/security', label: 'Security', adminOnly: true, moduleKey: 'security' }
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
  const [dealershipLoanerVisible, setDealershipLoanerVisible] = useState(() => String(me?.role || '').toUpperCase() === 'SUPER_ADMIN');

  const idleTimerRef = useRef(null);
  const role = String(me?.role || '').toUpperCase();
  const isAdminNavRole = ['SUPER_ADMIN', 'ADMIN', 'OPS'].includes(role);
  const activeModule = pathnameToModule(pathname);
  const blockedModule = activeModule && !isModuleEnabled(me, activeModule) ? activeModule : null;

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
      const hasPinHint = localStorage.getItem('ui.hasPin') === '1';
      setHasPin(hasPinHint);
      const hasBackup = !!localStorage.getItem('superadmin_backup_token');
      const currentRole = String(me?.role || '').toUpperCase();
      setCanReturnSuper(hasBackup && currentRole !== 'SUPER_ADMIN');
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
    const currentRole = String(me?.role || '').toUpperCase();
    if (currentRole === 'SUPER_ADMIN') {
      setCarSharingVisible(true);
      setDealershipLoanerVisible(true);
      return;
    }
    if (!['ADMIN', 'OPS', 'AGENT'].includes(currentRole)) {
      setCarSharingVisible(false);
      setDealershipLoanerVisible(false);
      return;
    }

    (async () => {
      try {
        const token = readStoredToken();
        if (!token) return;
        const [carSharingRes, loanerRes] = await Promise.all([
          currentRole === 'AGENT'
            ? Promise.resolve(null)
            : fetch(`${API_BASE}/api/car-sharing/config`, {
                headers: { Authorization: `Bearer ${token}` }
              }),
          fetch(`${API_BASE}/api/dealership-loaner/config`, {
            headers: { Authorization: `Bearer ${token}` }
          })
        ]);
        if (carSharingRes?.ok) {
          const json = await carSharingRes.json();
          setCarSharingVisible(!!json?.enabled);
        } else {
          setCarSharingVisible(false);
        }
        if (loanerRes.ok) {
          const json = await loanerRes.json();
          setDealershipLoanerVisible(!!json?.enabled);
        } else {
          setDealershipLoanerVisible(false);
        }
      } catch {
        setCarSharingVisible(false);
        setDealershipLoanerVisible(false);
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
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((eventName) => window.addEventListener(eventName, onActivity, { passive: true }));
    armIdleLock();
    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, onActivity));
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

      await authApi('/lock-pin/verify', { method: 'POST', body: JSON.stringify({ pin: pinInput }) });
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
        <div className="brand-block">
          <div className="brand">Ride Fleet</div>
          <div className="brand-subtitle">Rental ops, guest journeys, reporting, and car sharing in one workspace.</div>
        </div>

        <div className="nav-section-label">Workspace</div>
        <div className="stack nav-stack">
          {NAV_ITEMS
            .filter((item) => !item.superOnly || role === 'SUPER_ADMIN')
            .filter((item) => !item.adminOnly || isAdminNavRole)
            .filter((item) => item.feature !== 'carSharing' || carSharingVisible)
            .filter((item) => item.feature !== 'dealershipLoaner' || dealershipLoanerVisible)
            .filter((item) => isModuleEnabled(me, item.moduleKey))
            .map((item) => (
              item.disabled ? (
                <span key={item.href} className="nav-link" style={{ opacity: 0.55, cursor: 'not-allowed' }}>
                  <span className="nav-label">{item.label}</span>
                </span>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`nav-link ${pathname?.startsWith(item.href) ? 'active' : ''}`}
                  onClick={() => setMobileOpen(false)}
                >
                  <span className="nav-label">{item.label}</span>
                </Link>
              )
            ))}
        </div>
      </aside>

      {mobileOpen ? <div className="drawer-backdrop" onClick={() => setMobileOpen(false)} /> : null}

      <main className="content">
        <div className="topbar glass">
          <div className="topbar-primary">
            <button
              className="mobile-menu-btn topbar-action-btn"
              aria-label="Open navigation menu"
              title="Open menu"
              onClick={() => setMobileOpen((v) => !v)}
            >
              ☰
            </button>
            <div className="topbar-identity">
              <div className="topbar-name">{me?.fullName || me?.name || me?.email || 'User'}</div>
              <div className="topbar-role">{me?.role || 'ADMIN'}</div>
            </div>
          </div>

          <div className="topbar-actions">
            {canReturnSuper ? <button className="button-subtle topbar-action-btn topbar-action-wide" title="Return to Super Admin" onClick={returnToSuperAdmin}>Return</button> : null}
            <button className="button-subtle topbar-action-btn" title="Toggle dark mode" onClick={() => setDarkMode((v) => !v)}>{darkMode ? 'Light' : 'Dark'}</button>
            <button className="button-subtle topbar-action-btn" title="Lock screen" onClick={lockNow}>Lock</button>
            <button className="topbar-action-btn" onClick={logout}>Logout</button>
          </div>
        </div>

        {blockedModule ? (
          <section className="glass card-lg stack">
            <div className="eyebrow">Access Controlled</div>
            <h2>Module not enabled for this user</h2>
            <p className="ui-muted">
              This account does not currently have access to this workspace module. A super admin or tenant admin can enable it from tenant module access or user module permissions.
            </p>
          </section>
        ) : children}
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
                <input
                  type="password"
                  placeholder="Enter PIN"
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') unlock(); }}
                />
              ) : (
                <div className="stack">
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>Set your unlock PIN (first time).</div>
                  <input type="password" placeholder="New PIN (min 4 digits)" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
                  <input type="password" placeholder="Confirm PIN" value={newPin2} onChange={(e) => setNewPin2(e.target.value)} />
                </div>
              )}

              {lockMsg ? <div className="label" style={{ marginTop: 8, color: '#fca5a5' }}>{lockMsg}</div> : null}

              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button onClick={unlock}>Unlock</button>
                <button className="button-subtle" onClick={resetMyPin}>Reset PIN</button>
                <button className="button-subtle" onClick={logout}>Logout</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
