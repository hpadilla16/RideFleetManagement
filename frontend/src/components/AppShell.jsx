'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, TOKEN_KEY, USER_KEY, readStoredToken } from '../lib/client';
import { isModuleEnabled, pathnameToModule } from '../lib/moduleAccess';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '../lib/i18n';

const NAV_ITEMS = [
  { href: '/dashboard', labelKey: 'nav.dashboard', moduleKey: 'dashboard' },
  { href: '/reservations', labelKey: 'nav.reservations', moduleKey: 'reservations' },
  { href: '/quotes', labelKey: 'nav.quotes', moduleKey: 'quotes' },
  { href: '/vehicles', labelKey: 'nav.vehicles', moduleKey: 'vehicles' },
  { href: '/vehicles/inventory-helper', labelKey: 'nav.inventoryHelper', moduleKey: 'vehicles' },
  { href: '/customers', labelKey: 'nav.customers', moduleKey: 'customers' },
  { href: '/people', labelKey: 'nav.people', adminOnly: true, moduleKey: 'people' },
  { href: '/planner', labelKey: 'nav.planner', moduleKey: 'planner' },
  { href: '/reports-v2', labelKey: 'nav.reports', moduleKey: 'reports' },
  // Inventory Reports now lives INSIDE Reports (tile on the /reports-v2 landing).
  { href: '/car-sharing', labelKey: 'nav.carSharing', feature: 'carSharing', moduleKey: 'carSharing' },
  { href: '/host', labelKey: 'nav.hostApp', feature: 'carSharing', moduleKey: 'hostApp' },
  // Employee App hidden 2026-06-16 — not in use right now (route still works at /employee).
  // { href: '/employee', labelKey: 'nav.employeeApp', moduleKey: 'employeeApp' },
  { href: '/issues', labelKey: 'nav.issueCenter', moduleKey: 'issueCenter' },
  { href: '/loaner', labelKey: 'nav.loaner', feature: 'dealershipLoaner', moduleKey: 'loaner' },
  { href: '/tolls', labelKey: 'nav.tolls', moduleKey: 'tolls' },
  { href: '/maintenance', labelKey: 'nav.maintenance', moduleKey: 'maintenance' },
  { href: '/citations', labelKey: 'nav.citations', moduleKey: 'citations' },
  // Self service (kiosk B3b): ops surface with live devices/sessions —
  // top-level like Maintenance, gated by the opt-in 'kiosk' module.
  { href: '/kiosks', labelKey: 'nav.kiosks', moduleKey: 'kiosk' },
  { href: '/market', labelKey: 'nav.marketIntelligence', adminOnly: true, moduleKey: 'marketIntelligence' },
  { href: '/suggestions', labelKey: 'nav.pricingSuggestions', adminOnly: true, moduleKey: 'marketIntelligence' },
  { href: '/knowledge-base', labelKey: 'nav.knowledgeBase' },
  { href: '/settings', labelKey: 'nav.settings', moduleKey: 'settings' },
  { href: '/tenants', labelKey: 'nav.tenants', superOnly: true, moduleKey: 'tenants' },
  { href: '/settings/security', labelKey: 'nav.security', adminOnly: true, moduleKey: 'security' },
  { href: '/settings/store-boards', labelKey: 'nav.actionBoards', adminOnly: true, moduleKey: 'settings' }
  // Agreement clauses removed from the sidebar — it already lives inside Settings.
];

const IDLE_LOCK_MS = 2 * 60 * 1000;

function formatDate(d) {
  return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function AppShell({ me, logout, children }) {
  const { t, i18n } = useTranslation();
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
  const [carSharingVisible, setCarSharingVisible] = useState(() => isModuleEnabled(me, 'carSharing'));
  const [dealershipLoanerVisible, setDealershipLoanerVisible] = useState(() => isModuleEnabled(me, 'loaner'));

  const idleTimerRef = useRef(null);
  const role = String(me?.role || '').toUpperCase();
  // 2026-06-04 — per-user exemption (ops/reporting agent accounts): never
  // arm the idle lock and ignore any persisted locked flag for these users.
  const screenLockExempt = !!me?.screenLockExempt;
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
      if (persistedLocked && !me?.screenLockExempt) {
        setLocked(true);
        setNow(new Date());
      }
      if (me?.screenLockExempt) {
        try { localStorage.removeItem('ui.screenLocked'); } catch {}
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
    setCarSharingVisible(isModuleEnabled(me, 'carSharing'));
    setDealershipLoanerVisible(isModuleEnabled(me, 'loaner'));
  }, [me]);

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
    if (screenLockExempt) {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (locked) setLocked(false);
      return;
    }
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
  }, [locked, armIdleLock, screenLockExempt]);

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
        if (!newPin || newPin.length < 4) return setLockMsg(t('lockScreen.pinTooShort'));
        if (newPin !== newPin2) return setLockMsg(t('lockScreen.pinMismatch'));
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
        setLockMsg(t('lockScreen.tooManyAttempts'));
        setTimeout(() => logout(), 500);
        return;
      }
      setLockMsg(`${e.message || t('lockScreen.invalidPin')} ${t('lockScreen.attemptsSuffix', { count: nextFails })}`);
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
      setLockMsg(t('lockScreen.pinReset'));
    } catch (e) {
      setLockMsg(e.message || t('lockScreen.unableToReset'));
    }
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar glass ${mobileOpen ? 'open' : ''}`}>
        <div className="brand-block">
          <div className="brand">Ride Fleet</div>
          <div className="brand-subtitle">{t('appShell.brandSubtitle')}</div>
        </div>

        <div className="nav-section-label">{t('appShell.workspace')}</div>
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
                  <span className="nav-label">{t(item.labelKey)}</span>
                </span>
              ) : (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`nav-link ${pathname?.startsWith(item.href) ? 'active' : ''}`}
                  onClick={() => setMobileOpen(false)}
                >
                  <span className="nav-label">{t(item.labelKey)}</span>
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
              aria-label={t('appShell.openNavMenu')}
              title={t('appShell.openMenu')}
              onClick={() => setMobileOpen((v) => !v)}
            >
              ☰
            </button>
            <div className="topbar-identity">
              <div className="topbar-name">{me?.fullName || me?.name || me?.email || t('appShell.userFallback')}</div>
              <div className="topbar-role">{me?.role || 'ADMIN'}</div>
            </div>
          </div>

          <div className="topbar-actions">
            {canReturnSuper ? <button className="button-subtle topbar-action-btn topbar-action-wide" title={t('topbar.returnToSuperAdmin')} onClick={returnToSuperAdmin}>{t('appShell.return')}</button> : null}
            <button className="button-subtle topbar-action-btn" title={t('appShell.openCustomerDisplay')} style={{ background: 'rgba(22,163,74,.1)', borderColor: 'rgba(22,163,74,.2)', color: '#166534' }} onClick={() => window.open('/customer-display', 'customer-display', 'width=600,height=900,scrollbars=yes,resizable=yes')}>{t('appShell.display')}</button>
            <button className="button-subtle topbar-action-btn" onClick={() => setLanguage(i18n.language === 'es' ? 'en' : 'es')} style={{ fontWeight: 700, letterSpacing: '.03em' }}>{i18n.language === 'es' ? 'EN' : 'ES'}</button>
            <button className="button-subtle topbar-action-btn" title={t('appShell.toggleDarkMode')} onClick={() => setDarkMode((v) => !v)}>{darkMode ? t('topbar.light') : t('topbar.dark')}</button>
            <button className="button-subtle topbar-action-btn" title={t('topbar.lock')} onClick={lockNow}>{t('topbar.lock')}</button>
            <button className="topbar-action-btn" onClick={logout}>{t('topbar.logout')}</button>
          </div>
        </div>

        {blockedModule ? (
          <section className="glass card-lg stack">
            <div className="eyebrow">{t('blockedModule.eyebrow')}</div>
            <h2>{t('blockedModule.title')}</h2>
            <p className="ui-muted">
              {t('blockedModule.body')}
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
            <div className="screenlock-user">{me?.fullName || me?.name || me?.email || t('appShell.userFallback')}</div>

            <div className="screenlock-card glass card">
              <h3 style={{ marginBottom: 8 }}>{t('lockScreen.screenLocked')}</h3>
              {hasPin ? (
                <input
                  type="password"
                  placeholder={t('lockScreen.enterPin')}
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') unlock(); }}
                />
              ) : (
                <div className="stack">
                  <div className="label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{t('lockScreen.setPin')}</div>
                  <input type="password" placeholder={t('lockScreen.newPin')} value={newPin} onChange={(e) => setNewPin(e.target.value)} />
                  <input type="password" placeholder={t('lockScreen.confirmPin')} value={newPin2} onChange={(e) => setNewPin2(e.target.value)} />
                </div>
              )}

              {lockMsg ? <div className="label" style={{ marginTop: 8, color: '#fca5a5' }}>{lockMsg}</div> : null}

              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button onClick={unlock}>{t('lockScreen.unlock')}</button>
                <button className="button-subtle" onClick={resetMyPin}>{t('appShell.resetPin')}</button>
                <button className="button-subtle" onClick={logout}>{t('topbar.logout')}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
