'use client';

/**
 * The first-login offer — the missing trigger of the whole self-training arc.
 *
 * The ONBOARDING tour has existed since day one, but nothing fired it: a new
 * employee had to already know Ride University existed to find the tour that
 * introduces Ride University. This closes the loop, as an OFFER rather than a
 * hijack (the D2.5 deferral was right about that much): a small card on the
 * dashboard, two buttons, and either answer is remembered so it never nags.
 *
 * WHO sees it: someone signed in, on the dashboard, with ZERO training
 * progress on the server, who has never answered the offer on this device,
 * and who is not mid-practice. The server check is what keeps a veteran who
 * cleared their browser from being greeted like a stranger — any progress at
 * all suppresses the card for good.
 *
 * Mounted in app/layout.js (it must not remount per page while the person
 * navigates before answering), renders nothing for everyone else.
 */
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { api, readStoredToken, USER_KEY } from '../../lib/client';
import { inPracticeMode } from '../../lib/training/practice';
import { TOUR_START_EVENT } from './TourHost';

const ANSWERED_KEY = 'ride-university:welcome-answered';
/** Let the dashboard settle before offering — never race the first paint. */
const OFFER_DELAY_MS = 2500;

export function WelcomeOffer() {
  const { t } = useTranslation();
  const pathname = usePathname();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (pathname !== '/') return undefined;
    let alive = true;
    let timer = 0;
    try {
      if (window.localStorage.getItem(ANSWERED_KEY)) return undefined;
      if (inPracticeMode()) return undefined;
      const raw = window.localStorage.getItem(USER_KEY);
      const me = raw ? JSON.parse(raw) : null;
      if (!me?.role) return undefined;
      // A SUPER_ADMIN has no tenant and no training denominator — greeting
      // the platform owner like a new hire on every fresh device is noise.
      if (me.role === 'SUPER_ADMIN') return undefined;
    } catch { return undefined; }

    (async () => {
      try {
        const token = readStoredToken();
        if (!token) return;
        const out = await api('/api/training/progress', { bypassCache: true }, token);
        if (!alive) return;
        // Any history at all — armed, completed, anything — means this is not
        // a first login, whatever this device remembers.
        if (Array.isArray(out?.progress) && out.progress.length > 0) {
          try { window.localStorage.setItem(ANSWERED_KEY, 'veteran'); } catch { /* fine */ }
          return;
        }
        timer = setTimeout(() => { if (alive) setShow(true); }, OFFER_DELAY_MS);
      } catch { /* the offer never blocks or breaks a dashboard */ }
    })();
    return () => { alive = false; clearTimeout(timer); };
  }, [pathname]);

  if (!show) return null;

  const answer = (accepted) => {
    try { window.localStorage.setItem(ANSWERED_KEY, accepted ? 'accepted' : 'declined'); } catch { /* fine */ }
    setShow(false);
    if (accepted) {
      window.dispatchEvent(new CustomEvent(TOUR_START_EVENT, { detail: { track: 'ONBOARDING' } }));
    }
  };

  return (
    <div
      role="dialog"
      aria-label={t('training.welcomeTitle', 'Welcome to Ride Fleet')}
      style={{
        position: 'fixed', right: 18, bottom: 18, zIndex: 9998,
        width: 'min(360px, calc(100vw - 36px))',
        background: '#fff', color: '#1e1a2b',
        borderRadius: 14, padding: '16px 18px',
        boxShadow: '0 8px 30px rgba(30,26,43,.25)',
        border: '1px solid #eceaf2',
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 22 }} aria-hidden="true">🎓</span>
        <strong style={{ fontSize: 15 }}>{t('training.welcomeTitle', 'Welcome to Ride Fleet')}</strong>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 13.5, lineHeight: 1.5, color: '#5b5266' }}>
        {t('training.welcomeBody', 'First time here? In five minutes I can walk you through where everything lives — and you can relaunch the tour any time from Ride University.')}
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="button-subtle" onClick={() => answer(false)}>
          {t('training.welcomeLater', 'Not now')}
        </button>
        <button type="button" onClick={() => answer(true)}>
          {t('training.welcomeStart', 'Show me around')}
        </button>
      </div>
    </div>
  );
}
