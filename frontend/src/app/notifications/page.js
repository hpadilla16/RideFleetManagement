'use client';

// Notification Center (2026-09-01, approved mockup).
// Source of truth: design/mockups/notification-center-mockup.html (Mock 2) +
// design/mockups/notifications-NOTES.md. One severity-ranked feed over every
// source, with per-user read state and team-visible acknowledge. AGGREGATES,
// REPLACES NOTHING: every row deep-links to the surface that owns the work
// (tolls tray, maintenance due list, kiosk queue, reservation).
//
// - Lanes are saved filters over one feed (same rail pattern as tolls), with
//   DB counts from the API (never counted off the loaded page).
// - Read ≠ acknowledge: read tints the row per-user; acknowledge is
//   per-tenant, shows WHO + WHEN, and delegates server-side to the source's
//   own endpoint where one exists (geofence dismiss, toll staff-ack).
// - Muted rules + Delivery settings tabs are honest post-MVP stubs.
// - No moduleKey: the page shows only what the API already scopes to the
//   caller (effectiveLocationIds + role-gated categories).

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { AuthGate } from '../../components/AuthGate';
import { AppShell } from '../../components/AppShell';
import { api } from '../../lib/client';
import {
  NOTIFICATION_LANE_GROUPS,
  laneCount,
  notificationTitle,
  severityTone,
  groupByDay,
} from '../../lib/notification-lanes';

const PAGE_LIMIT = 50;

function SevIcon({ tone }) {
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
  if (tone === 'warn') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 22V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v18" />
      <path d="M2 22h20" />
      <path d="M9 6h6M9 10h6M9 14h6" />
    </svg>
  );
}

function formatTime(d, lang) {
  try {
    return new Date(d).toLocaleTimeString(lang === 'es' ? 'es-PR' : 'en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDayDate(d, lang) {
  try {
    return new Date(d).toLocaleDateString(lang === 'es' ? 'es-PR' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/** The feed body — exported for component tests. */
export function NotificationsFeed({ items, locationNames = {}, onOpen, onAck }) {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language || 'en';
  const groups = useMemo(() => groupByDay(items), [items]);
  if (!items.length) {
    return <div className="nc-empty">{t('notifications.empty', 'Nothing needs your attention')}</div>;
  }
  return (
    <>
      {groups.map((g) => (
        <Fragment key={g.key}>
          <div className="nc-day">
            {g.kind === 'today' ? `${t('notifications.today', 'Today')} · ` : null}
            {g.kind === 'yesterday' ? `${t('notifications.yesterday', 'Yesterday')} · ` : null}
            {formatDayDate(g.date, lang)}
          </div>
          {g.items.map((item) => {
            const tone = severityTone(item.severity, item.resolvedAt);
            return (
              <div key={item.id} className={`nc-row${item.read ? '' : ' unread'}`} data-testid="nc-row">
                <span className={`nc-sev nc-sev--${tone}`}><SevIcon tone={tone} /></span>
                <div className="nc-body">
                  <b>{notificationTitle(t, item)}</b>
                  <small>
                    {item.body ? <>{item.body} · </> : null}
                    <span className="nc-src">{t(`notifications.src.${item.sourceType}`, item.sourceType)}</span>
                  </small>
                </div>
                {item.locationId ? (
                  <span className="nc-loc">{locationNames[item.locationId] || ''}</span>
                ) : null}
                <time className="nc-time">{formatTime(item.createdAt, lang)}</time>
                <div className="nc-act">
                  {item.resolvedAt && !item.ackAt ? (
                    <span className="nc-ack-note">{t('notifications.ack.self', 'Self-resolved')}</span>
                  ) : null}
                  {item.ackAt ? (
                    <span className="nc-ack-note">
                      {t('notifications.ack.by', {
                        name: item.ackByName || '—',
                        time: formatTime(item.ackAt, lang),
                        defaultValue: `Acknowledged by ${item.ackByName || '—'} · ${formatTime(item.ackAt, lang)}`,
                      })}
                    </span>
                  ) : null}
                  {!item.ackAt && !item.resolvedAt ? (
                    <button type="button" className="nc-btn" onClick={() => onAck(item)}>
                      {t('notifications.ack.action', 'Acknowledge')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="nc-go"
                    aria-label={t('notifications.open', 'Open')}
                    onClick={() => onOpen(item)}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M7 17 17 7M8 7h9v9" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </Fragment>
      ))}
    </>
  );
}

function NotificationsInner({ me, logout }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [tab, setTab] = useState('inbox');
  const [lane, setLane] = useState('all');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ severity: {}, sourceType: {} });
  const [locationNames, setLocationNames] = useState({});
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const laneDef = useMemo(() => {
    for (const g of NOTIFICATION_LANE_GROUPS) {
      const found = g.lanes.find((l) => l.id === lane);
      if (found) return found;
    }
    return { id: 'all', filter: {} };
  }, [lane]);

  const buildQuery = (before) => {
    const p = new URLSearchParams();
    if (laneDef.filter.severity) p.set('severity', laneDef.filter.severity);
    if (laneDef.filter.sourceType) p.set('sourceType', laneDef.filter.sourceType);
    if (tab === 'acknowledged') p.set('tab', 'acknowledged');
    p.set('limit', String(PAGE_LIMIT));
    if (before) p.set('before', before);
    return p.toString();
  };

  const load = async () => {
    setLoading(true);
    setMsg('');
    try {
      const out = await api(`/api/notifications?${buildQuery()}`, { bypassCache: true });
      setItems(Array.isArray(out?.items) ? out.items : []);
      setTotal(Number(out?.total) || 0);
      setCounts(out?.counts || { severity: {}, sourceType: {} });
    } catch (error) {
      setMsg(error.message);
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    try {
      const out = await api(`/api/notifications?${buildQuery(new Date(last.createdAt).toISOString())}`, { bypassCache: true });
      setItems((prev) => [...prev, ...(out?.items || [])]);
    } catch (error) {
      setMsg(error.message);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lane, tab]);

  // Sede names for the location column — one soft-fail fetch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const out = await api('/api/locations/selectable', { skipViewLocation: true });
        if (cancelled) return;
        const map = {};
        for (const l of out?.locations || out || []) {
          if (l?.id) map[l.id] = l.code ? `${l.code} · ${l.name}` : l.name;
        }
        setLocationNames(map);
      } catch { /* names are decoration */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const onOpen = (item) => {
    if (!item.read) {
      api(`/api/notifications/${item.id}/read`, { method: 'POST', body: JSON.stringify({}) }).catch(() => {});
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
    }
    if (item.deepLink) router.push(item.deepLink);
  };

  const onAck = async (item) => {
    try {
      const out = await api(`/api/notifications/${item.id}/acknowledge`, { method: 'POST', body: JSON.stringify({}) });
      setItems((prev) => prev.map((i) => (i.id === item.id
        ? { ...i, read: true, ackAt: out?.ackAt || new Date().toISOString(), ackByName: out?.ackByName || null }
        : i)));
    } catch (error) {
      setMsg(error.message);
    }
  };

  const markAllRead = async () => {
    try {
      await api('/api/notifications/read-all', { method: 'POST', body: JSON.stringify({}) });
      setItems((prev) => prev.map((i) => ({ ...i, read: true })));
    } catch (error) {
      setMsg(error.message);
    }
  };

  const inboxCount = laneCount(counts, {});

  return (
    <AppShell me={me} logout={logout}>
      <div className="nc-head">
        <div className="nc-title-row">
          <h2>{t('notifications.title', 'Notifications')}</h2>
          <span className="nc-sub">{t('notifications.sub', 'Everything that asked for attention, in one feed')}</span>
        </div>
        <nav className="nc-tabs">
          <button type="button" className={tab === 'inbox' ? 'is-on' : ''} onClick={() => setTab('inbox')}>
            {t('notifications.tabs.inbox', 'Inbox')} <span className="cnt tnum">{inboxCount}</span>
          </button>
          <button type="button" className={tab === 'acknowledged' ? 'is-on' : ''} onClick={() => setTab('acknowledged')}>
            {t('notifications.tabs.acknowledged', 'Acknowledged')}
          </button>
          <button type="button" className={tab === 'muted' ? 'is-on' : ''} onClick={() => setTab('muted')}>
            {t('notifications.tabs.muted', 'Muted rules')}
          </button>
          <button type="button" className={tab === 'delivery' ? 'is-on' : ''} onClick={() => setTab('delivery')}>
            {t('notifications.tabs.delivery', 'Delivery settings')}
          </button>
        </nav>
      </div>

      {msg ? <div className="label">{msg}</div> : null}

      {tab === 'muted' || tab === 'delivery' ? (
        <div className="nc-stub">
          {tab === 'muted'
            ? t('notifications.comingSoon.muted', 'Muted rules are coming soon — per-user mutes by category and sede, never for critical alerts.')
            : t('notifications.comingSoon.delivery', 'Delivery settings are coming soon — the existing per-surface email and SMS fan-outs keep working unchanged until then.')}
        </div>
      ) : (
        <>
          <div className="nc-toolbar">
            <button type="button" className="nc-btn" onClick={load} disabled={loading}>
              {t('notifications.toolbar.refresh', 'Refresh')}
            </button>
            <span className="nc-ml-auto" />
            <button type="button" className="nc-btn" onClick={markAllRead}>
              {t('notifications.markAll', 'Mark all read')}
            </button>
          </div>

          <div className="tq-body nc-feed-wrap">
            <aside className="tq-rail" aria-label={t('notifications.title', 'Notifications')}>
              {NOTIFICATION_LANE_GROUPS.map((group) => (
                <Fragment key={group.id}>
                  <div className={`tq-grp g-${group.tone}`}><i />{t(`notifications.lanes.${group.id}`, group.id)}</div>
                  {group.lanes.map((l) => {
                    const n = laneCount(counts, l.filter);
                    const hot = group.tone === 'bad' && n > 0 ? ' hot' : (group.tone === 'warn' && n > 0 ? ' warm' : '');
                    return (
                      <button
                        key={l.id}
                        type="button"
                        className={`tq-lane${lane === l.id ? ' is-on' : ''}`}
                        onClick={() => setLane(l.id)}
                      >
                        {t(`notifications.lanes.${l.id}`, l.id)}
                        <span className={`n${hot}`}>{n}</span>
                      </button>
                    );
                  })}
                </Fragment>
              ))}
              <div className="tq-rail-note">{t('notifications.railNote', 'Lanes are saved filters over one feed, not separate inboxes. Counts are open items in your location scope.')}</div>
            </aside>

            <div className="tq-main">
              <NotificationsFeed items={items} locationNames={locationNames} onOpen={onOpen} onAck={onAck} />
              <div className="nc-foot">
                <span>
                  {t('notifications.foot.showing', { a: items.length, b: total, defaultValue: `Showing ${items.length} of ${total} in your location scope` })}
                  {' · '}
                  {t('notifications.foot.archive', 'older items auto-archive after 30 days')}
                </span>
                {items.length < total ? (
                  <a href="#more" onClick={(e) => { e.preventDefault(); loadMore(); }}>
                    {t('notifications.foot.loadMore', 'Load more')} ↓
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}

export default function NotificationsPage() {
  return <AuthGate>{({ me, logout }) => <NotificationsInner me={me} logout={logout} />}</AuthGate>;
}
