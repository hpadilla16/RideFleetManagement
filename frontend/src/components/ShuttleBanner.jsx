'use client';

/**
 * Shuttle Request banner (Valet arc, 2026-08-05).
 *
 * A customer is physically standing at an airport curb — so this is NOT a
 * dashboard tile. It renders inside AppShell, above the page content, on
 * every staff screen. Rules from the spec:
 *
 *  - only "View" clears it: it navigates to the queue, and the queue page
 *    marks the requests VIEWED. Changing pages or reloading does NOT clear it
 *    (the banner derives from server state, not client state).
 *  - a repeat caller re-fires it: the backend snaps the row back to READY on
 *    every repeat call, so the poll picks it up again even if it was viewed.
 *  - the wait time is the number that creates urgency, so it leads.
 *
 * Fetch is soft-fail: roles without the reservations module (or a backend
 * mid-deploy) just don't see a banner — the shell must never break.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { api, readStoredToken } from '../lib/client';

const POLL_MS = 20000;
// After this many consecutive failures the banner stops polling until reload.
const MAX_FAILURES = 5;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

function minutesSince(value) {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

export function ShuttleBanner() {
  const { t } = useTranslation();
  const router = useRouter();
  const [ready, setReady] = useState([]);

  // Backoff + circuit breaker (2026-08-08 incident review).
  //
  // This banner is mounted on EVERY screen and polled a bypass-cache request
  // every 20s with no failure handling: the catch swallowed the error and the
  // interval kept firing. When the backend stalled, each hung poll held one of
  // the browser's ~6 connections per origin (the site is HTTP/1.1), so tabs ran
  // out of sockets and could not load data even from a healthy endpoint. A
  // banner that shows shuttle requests must never be the reason the rest of
  // the app cannot talk to the server.
  //
  // Now: exponential backoff on consecutive failures, and after
  // MAX_FAILURES it stops entirely until the page is reloaded. One slow
  // endpoint degrades one banner instead of the whole tab.
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
      const token = readStoredToken();
      if (!token) return schedule(POLL_MS);
      // A background tab has nobody looking at the banner. Polling it anyway
      // spends a request and — on HTTP/1.1, before we enabled h2 — one of the
      // browser's six connections per origin, on a screen that cannot be read.
      // Suggested in the 2026-08-09 shuttle report; worth taking on its own
      // merits even though it was not the outage.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return schedule(POLL_MS);
      }
      try {
        const out = await api('/api/shuttle-requests?status=open', { bypassCache: true }, token);
        if (cancelled) return;
        const rows = Array.isArray(out?.rows) ? out.rows : [];
        const readyRows = rows.filter((r) => r.status === 'READY');
        setReady(readyRows);
        // Feed the AppShell "Shuttles" nav badge from THIS poll — one fetch
        // serves both surfaces, the shell never adds its own (2026-08-24).
        try { window.dispatchEvent(new CustomEvent('shuttle:openCount', { detail: readyRows.length })); } catch { /* badge only */ }
        failures = 0;
        schedule(POLL_MS);
      } catch {
        if (cancelled) return;
        failures += 1;
        setReady([]);
        try { window.dispatchEvent(new CustomEvent('shuttle:openCount', { detail: 0 })); } catch { /* badge only */ }
        // Give up rather than keep consuming a connection every 20s.
        if (failures >= MAX_FAILURES) return;
        schedule(Math.min(POLL_MS * 2 ** failures, MAX_BACKOFF_MS));
      }
    };

    poll();
    // Come back immediately when the operator returns to the tab, so hiding it
    // costs freshness only while it is hidden.
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

  if (!ready.length) return null;

  const first = ready[0];
  const waited = minutesSince(first.createdAt);
  return (
    <div className="shuttle-banner" role="alert">
      <span className="shuttle-banner-icon" aria-hidden="true">🚐</span>
      <span className="shuttle-banner-text">
        <strong>
          {t('shuttle.bannerTitle', {
            defaultValue: '{{count}} customer(s) ready for airport pickup — please send the shuttle',
            count: ready.length,
          })}
        </strong>
        <span className="shuttle-banner-detail">
          {first.customerName}
          {first.reservation?.reservationNumber ? ` (${first.reservation.reservationNumber})` : ''}
          {' · '}
          {t('shuttle.bannerParty', { defaultValue: '{{count}} pers.', count: first.partySize })}
          {first.pickupNote ? ` · ${first.pickupNote}` : ''}
          {first.callCount > 1 ? ` · ${t('shuttle.calledTimes', { defaultValue: 'called ×{{count}}', count: first.callCount })}` : ''}
          {waited != null ? ` · ${t('shuttle.waitingFor', { defaultValue: 'waiting {{minutes}} min', minutes: waited })}` : ''}
        </span>
      </span>
      <button type="button" className="shuttle-banner-action" onClick={() => router.push('/shuttle')}>
        {t('shuttle.view', 'View')}
      </button>
    </div>
  );
}
