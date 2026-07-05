'use client';

/**
 * Ride Kiosk — KioskShell (Fase B3b, 2026-07-05).
 * Mockup: doc/kiosk-mockups-2026-07-04.html (Rev 2, Hector-approved).
 *
 * PUBLIC fullscreen shell for the lobby tablet — no AppShell, no user auth
 * (device auth is the X-Kiosk-Token header, see lib/kioskClient.js). Owns:
 *   • header brand (device name) + EN/ES toggle (persists per device via the
 *     shared i18n localStorage key) + Help button,
 *   • footer (privacy line + online dot),
 *   • idle handling: 2 min without touch while a session is active → K-E1
 *     "Are you still there?" with a 30s countdown → wipes the session (the
 *     page registers the wipe handler through KioskUiContext).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '../../lib/i18n';
import { KIOSK_ERR_UNPAIRED, readDeviceInfo, readDeviceToken, refreshOwnDevice } from '../../lib/kioskClient';
import { KIOSK_UNPAIRED_EVENT, KioskUiContext } from '../../components/kiosk/KioskUiContext';
import './kiosk.css';

const IDLE_AFTER_MS = 2 * 60 * 1000; // 2 min without touch → K-E1
const IDLE_COUNTDOWN_S = 30; // K-E1 grace before the wipe

export default function KioskLayout({ children }) {
  const { t, i18n } = useTranslation();
  const [device, setDevice] = useState(null);
  const [helpTick, setHelpTick] = useState(0);
  const [idleOpen, setIdleOpen] = useState(false);
  const [countdown, setCountdown] = useState(IDLE_COUNTDOWN_S);
  // Footer connectivity dot — wired to the last request outcome (the wizard
  // flips it false when a call dies with NETWORK_UNAVAILABLE → K-E4).
  const [online, setOnline] = useState(true);

  const sessionActiveRef = useRef(false);
  const idleTimerRef = useRef(null);
  const idleResetRef = useRef(null);
  const idleOpenRef = useRef(false);

  // Boot: show the cached device immediately, then refresh from
  // GET /api/kiosk/device (picks up rename/walkupEnabled/location without
  // re-pairing). A 401 means rotated/revoked → wipe + tell the page.
  useEffect(() => {
    setDevice(readDeviceInfo());
    if (!readDeviceToken()) return;
    refreshOwnDevice()
      .then((fresh) => { if (fresh) { setDevice(fresh); setOnline(true); } })
      .catch((e) => {
        if (e?.code === 'NETWORK_UNAVAILABLE') setOnline(false);
        if (e?.code === KIOSK_ERR_UNPAIRED) {
          setDevice(null);
          try { window.dispatchEvent(new CustomEvent(KIOSK_UNPAIRED_EVENT)); } catch {}
        }
        // Network failures stay silent here — the wizard's own calls route
        // to the out-of-service screen.
      });
  }, []);
  useEffect(() => { idleOpenRef.current = idleOpen; }, [idleOpen]);

  const armIdle = useMemo(() => () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (!sessionActiveRef.current) return;
    idleTimerRef.current = setTimeout(() => {
      if (!sessionActiveRef.current) return;
      setCountdown(IDLE_COUNTDOWN_S);
      setIdleOpen(true);
    }, IDLE_AFTER_MS);
  }, []);

  // Activity watch — any touch/click/key rearms the 2-min timer (but never
  // dismisses an open K-E1: that needs an explicit "I'm still here").
  useEffect(() => {
    const onActivity = () => { if (!idleOpenRef.current) armIdle(); };
    const events = ['pointerdown', 'touchstart', 'keydown'];
    events.forEach((name) => window.addEventListener(name, onActivity, { passive: true }));
    return () => {
      events.forEach((name) => window.removeEventListener(name, onActivity));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [armIdle]);

  // K-E1 countdown → 0 = wipe session + back to WELCOME.
  useEffect(() => {
    if (!idleOpen) return undefined;
    if (countdown <= 0) {
      setIdleOpen(false);
      idleResetRef.current?.();
      return undefined;
    }
    const timer = setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [idleOpen, countdown]);

  const contextValue = useMemo(() => ({
    device,
    setDevice,
    setSessionActive: (active) => {
      sessionActiveRef.current = !!active;
      if (active) armIdle();
      else {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        setIdleOpen(false);
      }
    },
    onIdleReset: (fn) => { idleResetRef.current = fn; },
    helpTick,
    online,
    setOnline,
  }), [device, helpTick, armIdle, online]);

  const lang = i18n.language === 'es' ? 'es' : 'en';

  return (
    <KioskUiContext.Provider value={contextValue}>
      <div className="kio-root">
        <div className="kio-bar">
          <div className="kio-brand">
            <div className="kio-logo">R</div>
            <div>
              {/* Bold line = the TENANT's guest-facing brand once the backend
                  ships device.tenant {name} on /pair + GET /device — null-safe
                  fallback to "Ride Kiosk" until that field lands. */}
              <b>{device?.tenant?.name || t('kiosk.brandTitle')}</b>
              <small>
                {device?.name
                  ? (device?.location?.name ? `${device.location.name} · ${device.name}` : device.name)
                  : t('kiosk.brandSubtitleUnpaired')}
              </small>
            </div>
          </div>
          <div className="kio-right">
            <span className="kio-lang">
              <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => setLanguage('en')}>EN</button>
              <button type="button" className={lang === 'es' ? 'on' : ''} onClick={() => setLanguage('es')}>ES</button>
            </span>
            <button type="button" className="kio-help" onClick={() => setHelpTick((n) => n + 1)}>
              🎧 {t('kiosk.help')}
            </button>
          </div>
        </div>

        {children}

        <div className="kio-foot">
          <span>{t('kiosk.footerPrivacy')}</span>
          <span className="kio-dim">
            Ride Kiosk · {online ? t('kiosk.footerOnline') : t('kiosk.footerOffline')}{' '}
            <span style={{ color: online ? '#047857' : '#be123c' }}>●</span>
          </span>
        </div>

        {idleOpen ? (
          <div className="kio-overlay">
            <div className="kio-overlay-card">
              <div className="kio-h2">{t('kiosk.idleTitle')}</div>
              <p className="kio-sub" style={{ margin: '0 auto 20px' }}>
                {t('kiosk.idleBody')}{' '}
                <b style={{ color: '#b45309', fontSize: 22 }}>{countdown}s</b>
              </p>
              <div className="kio-row">
                <button
                  type="button"
                  className="kio-btn sm"
                  onClick={() => { setIdleOpen(false); armIdle(); }}
                >
                  {t('kiosk.idleStillHere')}
                </button>
                <button
                  type="button"
                  className="kio-btn ghost sm"
                  onClick={() => { setIdleOpen(false); idleResetRef.current?.(); }}
                >
                  {t('kiosk.idleStartOver')}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </KioskUiContext.Provider>
  );
}
