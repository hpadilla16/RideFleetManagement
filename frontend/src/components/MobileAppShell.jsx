'use client';

import { useEffect, useMemo, useState } from 'react';

function renderValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  return value;
}

function getDisplayContext() {
  if (typeof window === 'undefined') {
    return { isStandalone: false, isNativeWrapper: false, label: 'Mobile Beta' };
  }
  const isStandalone = !!(
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.navigator?.standalone
  );
  const isNativeWrapper = !!(
    window.Capacitor?.isNativePlatform?.() ||
    window.Capacitor?.platform === 'android' ||
    window.Capacitor?.platform === 'ios'
  );
  if (isNativeWrapper) return { isStandalone: true, isNativeWrapper: true, label: 'Native Beta' };
  if (isStandalone) return { isStandalone: true, isNativeWrapper: false, label: 'Installed App' };
  return { isStandalone: false, isNativeWrapper: false, label: 'Browser Beta' };
}

export function MobileAppShell({ eyebrow, title, description, statusLabel, stats = [], tabs = [], storageKey = '' }) {
  const [currentHash, setCurrentHash] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const [displayContext, setDisplayContext] = useState(() => getDisplayContext());

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncHash = () => setCurrentHash(window.location.hash || '');
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncDisplayContext = () => setDisplayContext(getDisplayContext());
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      syncDisplayContext();
    };
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);

    syncDisplayContext();
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const storedHref = useMemo(() => {
    if (!storageKey || typeof window === 'undefined') return '';
    try {
      return localStorage.getItem(`mobile-shell:${storageKey}`) || '';
    } catch {
      return '';
    }
  }, [storageKey, currentHash]);

  const resolvedActiveHref = currentHash || storedHref || tabs.find((tab) => tab.active)?.href || tabs[0]?.href || '';
  const resumeTab = tabs.find((tab) => tab.href === storedHref);

  const persistTab = (href) => {
    if (!storageKey) return;
    try {
      localStorage.setItem(`mobile-shell:${storageKey}`, href);
    } catch {}
  };

  const promptInstall = async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice?.catch(() => null);
    } finally {
      setInstallPrompt(null);
      setDisplayContext(getDisplayContext());
    }
  };

  return (
    <section className="glass card-lg section-card mobile-app-shell">
      <div className="app-banner">
        <div className="row-between" style={{ alignItems: 'start', marginBottom: 0, gap: 12 }}>
          <div className="stack" style={{ gap: 6 }}>
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            <h2 className="page-title" style={{ margin: 0 }}>{title}</h2>
            <p className="ui-muted">{description}</p>
          </div>
          {statusLabel ? <span className="status-chip neutral">{statusLabel}</span> : null}
        </div>

        <div className="mobile-app-shell-meta">
          <span className={`status-chip ${isOnline ? 'good' : 'warn'}`}>{isOnline ? 'Online' : 'Offline'}</span>
          <span className="status-chip neutral">{displayContext.label}</span>
          {storageKey ? <span className="status-chip neutral">Session resume on</span> : null}
          {!displayContext.isStandalone && installPrompt ? (
            <button type="button" className="button-subtle mobile-install-btn" onClick={promptInstall}>Install App</button>
          ) : null}
        </div>

        {stats.length ? (
          <div className="app-card-grid compact">
            {stats.map((stat) => (
              <div key={stat.label} className="doc-card">
                <strong>{stat.label}</strong>
                <div className="doc-meta">{renderValue(stat.value)}</div>
              </div>
            ))}
          </div>
        ) : null}

        {resumeTab && !currentHash ? (
          <div className="surface-note">
            Resume where you left off in <strong>{resumeTab.label}</strong>.
            <div className="inline-actions" style={{ marginTop: 10 }}>
              <a href={resumeTab.href} onClick={() => persistTab(resumeTab.href)}>
                <button type="button" className="button-subtle">Resume Section</button>
              </a>
            </div>
          </div>
        ) : null}

        {tabs.length ? (
          <div className="mobile-app-shell-nav">
            {tabs.map((tab) => (
              <a
                key={`${tab.href}:${tab.label}`}
                href={tab.href}
                className={`mobile-app-shell-link ${resolvedActiveHref === tab.href ? 'active' : ''}`}
                onClick={() => persistTab(tab.href)}
              >
                {tab.label}
              </a>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
