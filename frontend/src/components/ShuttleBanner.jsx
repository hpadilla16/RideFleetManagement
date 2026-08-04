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

function minutesSince(value) {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

export function ShuttleBanner() {
  const { t } = useTranslation();
  const router = useRouter();
  const [ready, setReady] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const token = readStoredToken();
      if (!token) return;
      try {
        const out = await api('/api/shuttle-requests?status=open', { bypassCache: true }, token);
        if (cancelled) return;
        const rows = Array.isArray(out?.rows) ? out.rows : [];
        setReady(rows.filter((r) => r.status === 'READY'));
      } catch {
        if (!cancelled) setReady([]);
      }
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
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
