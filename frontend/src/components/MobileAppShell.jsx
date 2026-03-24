'use client';

import { useEffect, useMemo, useState } from 'react';

function renderValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  return value;
}

export function MobileAppShell({ eyebrow, title, description, statusLabel, stats = [], tabs = [], storageKey = '' }) {
  const [currentHash, setCurrentHash] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncHash = () => setCurrentHash(window.location.hash || '');
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
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
