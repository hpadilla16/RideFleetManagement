'use client';

/**
 * Ride Kiosk — Get Help ↔ VozIA chat embed overlay (B3f).
 * Contract: voice-ai-customer-service/KIOSK-EMBED.md v2 (source of truth).
 *
 * Full-screen iframe over the wizard. The iframe owns the whole conversation
 * pipeline (Chloe → handoff → live agent, video inside the frame — hence
 * allow="camera; microphone"). This component is ONLY the postMessage bridge:
 *   • {type:'conversation'} → hands {conversationId, secret} up to the page
 *     (memory only — never persisted); null/null → discard INSTANTLY.
 *   • {type:'commands'} → hands the command list up (page applies + acks).
 *   • any authentic vozia message counts as guest activity (a guest talking
 *     to Chloe generates no shell touches — without this the idle wipe would
 *     kill a live conversation).
 * Origin-checked against the VozIA host; everything else is ignored.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildVoziaSrc, voziaOrigin } from '../../lib/voziaBridge';

export function VoziaHelpOverlay({ t, vozia, locationId, reservationNumber, hasConversation, onConversation, onCommands, onActivity, onClose }) {
  // Contract: kiosk=1 is ZERO-persistence — unmounting the iframe kills the
  // conversation for good (no resume). An accidental ✕ mid-live-agent (or
  // mid-video) would hang up on a human, so closing with an ACTIVE
  // conversation takes a two-tap confirm (mirrors VozIA's own "Empezar de
  // nuevo" convention). With no conversation yet, ✕ closes directly.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const iframeRef = useRef(null);
  const src = useMemo(
    () => buildVoziaSrc({
      host: vozia?.host,
      widgetKey: vozia?.widgetKey,
      locationId,
      reservationNumber,
    }),
    [vozia?.host, vozia?.widgetKey, locationId, reservationNumber],
  );

  useEffect(() => {
    const expectedOrigin = voziaOrigin(vozia?.host);
    if (!expectedOrigin) return undefined;
    const onMessage = (e) => {
      // Contract §0: verify e.origin against the VozIA host — plus pin the
      // SENDER to our own iframe's contentWindow (hardening: another
      // same-origin window can never feed the bridge).
      if (e.origin !== expectedOrigin || e.data?.source !== 'vozia') return;
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return;
      onActivity?.();
      if (e.data.type === 'conversation') {
        // {conversationId, secret} on create — BOTH null on reset/close.
        onConversation?.({
          conversationId: e.data.conversationId ?? null,
          secret: e.data.secret ?? null,
        });
      } else if (e.data.type === 'commands') {
        onCommands?.(Array.isArray(e.data.commands) ? e.data.commands : [], e.data.conversationId ?? null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [vozia?.host, onConversation, onCommands, onActivity]);

  if (!src) return null;

  return (
    <div className="kio-overlay" style={{ padding: 0, background: 'rgba(33,26,56,.7)', zIndex: 70 }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex' }}>
        <iframe
          ref={iframeRef}
          src={src}
          title={t('kiosk.voziaTitle')}
          allow="camera; microphone"
          style={{ flex: 1, border: 'none', width: '100%', height: '100%', background: '#fff' }}
        />
        {/* Discreet close — the wizard session continues underneath. */}
        <button
          type="button"
          aria-label={t('kiosk.voziaClose')}
          onClick={() => { if (hasConversation) setConfirmOpen(true); else onClose(); }}
          style={{
            position: 'absolute', top: 10, right: 10, zIndex: 2,
            width: 48, height: 48, borderRadius: 999, border: '1px solid rgba(135,82,254,.25)',
            background: 'rgba(255,255,255,.92)', color: '#4c1d95',
            fontSize: 20, fontWeight: 800, cursor: 'pointer',
            boxShadow: '0 6px 18px rgba(35,21,80,.25)',
          }}
        >
          ✕
        </button>
        {confirmOpen ? (
          <div
            style={{
              position: 'absolute', inset: 0, zIndex: 3, background: 'rgba(33,26,56,.55)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            }}
          >
            <div className="kio-overlay-card" style={{ maxWidth: 460 }}>
              <div className="kio-h2" style={{ fontSize: 22 }}>{t('kiosk.voziaEndTitle')}</div>
              <p className="kio-sub" style={{ margin: '6px auto 18px' }}>{t('kiosk.voziaEndBody')}</p>
              <div className="kio-row">
                <button type="button" className="kio-btn sm" onClick={() => setConfirmOpen(false)}>
                  {t('kiosk.voziaEndCancel')}
                </button>
                <button type="button" className="kio-btn ghost sm" onClick={onClose}>
                  {t('kiosk.voziaEndConfirm')}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
