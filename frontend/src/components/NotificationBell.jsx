'use client';

// Notification Center — the topbar bell (2026-09-01).
// Source of truth: design/mockups/notification-center-mockup.html (Mock 1) +
// notifications-NOTES.md. Sits in AppShell's topbar between search and the
// location picker — the one slot every staff screen shares.
//
// Poll discipline: EXACTLY the ShuttleBanner pattern (recursive setTimeout,
// visibility skip, exponential backoff, hard circuit-break) — see the
// 2026-08-08 connection-starvation incident documented there. 30s cadence,
// bypassCache mandatory. The badge is per-user unread CRITICAL+NEEDS_ACTION
// within the caller's location scope, capped at 99+ — INFO never badges.
//
// Read ≠ acknowledge: clicking a row marks it read (personal) and deep-links
// to the surface that owns the work. "Mark all read" clears the personal
// badge only — it never acknowledges on behalf of the team.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/client';
import {
  badgeLabel,
  matchesFilter,
  notificationTitle,
  severityTone,
  relativeTime,
} from '../lib/notification-lanes';

const POLL_MS = 30000;
const MAX_FAILURES = 5;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const PANEL_LIMIT = 15;

const SCOPES = [
  { id: 'all', filter: {} },
  { id: 'critical', filter: { severity: 'CRITICAL' } },
  { id: 'needsAction', filter: { severity: 'NEEDS_ACTION' } },
];

function SevIcon({ tone }) {
  // Minimal inline glyphs, same visual family as the mock.
  if (tone === 'bad') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
    );
  }
  if (tone === 'ok') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function NotificationBell() {
  const { t } = useTranslation();
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [scope, setScope] = useState('all');
  const [loading, setLoading] = useState(false);
  const rootRef = useRef(null);

  // Badge poll — ShuttleBanner discipline, 30s.
  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let failures = 0;

    const schedule = (ms) => {
      if (cancelled) return;
      timer = setTimeout(poll, ms);
    };

    const poll = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return schedule(POLL_MS);
      }
      try {
        const out = await api('/api/notifications/unread-count', { bypassCache: true });
        if (cancelled) return;
        setCount(Number(out?.count) || 0);
        failures = 0;
        schedule(POLL_MS);
      } catch {
        if (cancelled) return;
        failures += 1;
        // Soft-fail: keep the last known badge, back off, give up at 5.
        if (failures >= MAX_FAILURES) return;
        schedule(Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS));
      }
    };

    poll();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !cancelled) {
        if (timer) clearTimeout(timer);
        failures = 0;
        poll();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const loadPanel = async () => {
    setLoading(true);
    try {
      const out = await api(`/api/notifications?limit=${PANEL_LIMIT}`, { bypassCache: true });
      setItems(Array.isArray(out?.items) ? out.items : []);
      setCount(Number(out?.unread) || 0);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) loadPanel();
  };

  const markAllRead = async () => {
    try {
      await api('/api/notifications/read-all', { method: 'POST', body: JSON.stringify({}) });
      setCount(0);
      setItems((prev) => prev.map((i) => ({ ...i, read: true })));
    } catch { /* badge refreshes on next poll */ }
  };

  const openItem = async (item) => {
    setOpen(false);
    if (!item.read) {
      // Fire-and-forget: navigation must never wait on the read mark.
      api(`/api/notifications/${item.id}/read`, { method: 'POST', body: JSON.stringify({}) }).catch(() => {});
      setCount((c) => Math.max(0, c - 1));
    }
    router.push(item.deepLink || '/notifications');
  };

  const badge = badgeLabel(count);
  const active = SCOPES.find((s) => s.id === scope) || SCOPES[0];
  const visible = items.filter((i) => matchesFilter(i, active.filter));

  return (
    <span className="nb-root" ref={rootRef}>
      <button
        type="button"
        className={`nb-btn${open ? ' is-on' : ''}`}
        aria-label={t('notifications.bellAria', { count, defaultValue: `Notifications, ${count} unread` })}
        title={t('notifications.title', 'Notifications')}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {badge ? <span className="nb-badge">{badge}</span> : null}
      </button>

      {open ? (
        <div className="nb-panel" role="dialog" aria-label={t('notifications.title', 'Notifications')}>
          <div className="nb-head">
            <h4>{t('notifications.title', 'Notifications')}</h4>
            {count > 0 ? (
              <span className="nb-count">{t('notifications.unread', { count, defaultValue: `${count} unread` })}</span>
            ) : null}
            <button type="button" className="nb-mark" onClick={markAllRead}>
              {t('notifications.markAll', 'Mark all read')}
            </button>
          </div>
          <div className="nb-scopes">
            {SCOPES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={scope === s.id ? 'on' : ''}
                onClick={() => setScope(s.id)}
              >
                {t(`notifications.scopes.${s.id}`, s.id)}
              </button>
            ))}
          </div>
          <div className="nb-list">
            {loading && !visible.length ? <div className="nb-empty">…</div> : null}
            {!loading && !visible.length ? (
              <div className="nb-empty">{t('notifications.empty', 'Nothing needs your attention')}</div>
            ) : null}
            {visible.map((item) => {
              const tone = severityTone(item.severity, item.resolvedAt);
              return (
                <button type="button" key={item.id} className={`nb-row${item.read ? '' : ' unread'}`} onClick={() => openItem(item)}>
                  <span className={`nb-sev nb-sev--${tone}`}><SevIcon tone={tone} /></span>
                  <span className="nb-body">
                    <b>{notificationTitle(t, item)}</b>
                    {item.body ? <small>{item.body}</small> : null}
                  </span>
                  <span className="nb-meta">
                    <time>{relativeTime(item.createdAt)}</time>
                    {!item.read ? <span className="nb-dot" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="nb-foot">
            <a href="/notifications" onClick={(e) => { e.preventDefault(); setOpen(false); router.push('/notifications'); }}>
              {t('notifications.viewAll', 'View all in Notification Center')} →
            </a>
          </div>
        </div>
      ) : null}
    </span>
  );
}
