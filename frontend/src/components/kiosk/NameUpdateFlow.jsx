'use client';

/**
 * Ride Kiosk — B3e self-service name update (Hector's real case: FL license
 * "PADILLA LUNA HECTOR EDUARDO JR" vs reservation "Hector Padilla").
 *
 * Layer 1 (server token-subset matcher) already passed the harmless cases —
 * this flow only ever sees REAL mismatches. Proof of booking possession: a
 * 6-digit code goes to the email/phone ON THE RESERVATION (masked on screen);
 * a correct code updates the driver name to the OCR-VERIFIED license name
 * (never guest free text) and re-runs verify-id server-side.
 *
 * Phases: send (explainer + Send) → code (keypad + resend w/ 30s client
 * cooldown) → success (brief ✓ → parent continues to SELFIE) | locked.
 * All API calls flow through the parent's handlers (stale-guard + routeFatal
 * live in the page, telemetry is recorded server-side).
 */

import { useEffect, useState } from 'react';
import { useKioskUi } from './KioskUiContext';

const RESEND_COOLDOWN_S = 30;
// Email delivery takes 1-3 min — the default 2-min idle wipe would kill the
// flow mid-wait, so the CODE phase (only) extends the idle window.
const CODE_PHASE_IDLE_MS = 4 * 60 * 1000;

export function NameUpdateFlow({ t, onSendCode, onGetDestinations, onConfirmCode, onSuccess, onHelp, onExit }) {
  const ui = useKioskUi();
  const [phase, setPhase] = useState('send'); // send | code | success | locked
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [sent, setSent] = useState(null); // { email, sms }
  const [preview, setPreview] = useState(null); // pre-send masked destinations
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);

  // Pre-send destination preview ("the code will go to: …") so a guest whose
  // booking was made by someone ELSE can bail out before a code fires.
  // Null-safe: an older backend without the endpoint keeps the generic copy.
  useEffect(() => {
    let cancelled = false;
    onGetDestinations?.().then((out) => { if (!cancelled && out) setPreview(out); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Idle tolerance while waiting for the code — scoped STRICTLY to the code
  // phase; reset on leave/unmount (everything else keeps the 2-min default).
  useEffect(() => {
    if (phase !== 'code') return undefined;
    ui.setIdleMs?.(CODE_PHASE_IDLE_MS);
    return () => ui.setIdleMs?.(null);
  }, [phase, ui]);

  // Resend cooldown tick.
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // Brief success beat, then hand back to the wizard (SELFIE).
  useEffect(() => {
    if (phase !== 'success') return undefined;
    const timer = setTimeout(() => onSuccess(), 2500);
    return () => clearTimeout(timer);
  }, [phase, onSuccess]);

  const sendCode = async () => {
    if (busy || cooldown > 0) return;
    setBusy(true); setMsg('');
    const out = await onSendCode();
    setBusy(false);
    if (!out || out.code === 'FATAL' || out.code === 'STALE') return;
    if (out.ok) {
      setSent(out.sent || {});
      setCooldown(RESEND_COOLDOWN_S);
      setCode('');
      setPhase('code');
      return;
    }
    if (out.code === 'NAME_UPDATE_COOLDOWN') {
      // Server-side resend cooldown (60s) — NOT a lockout. Handle inline:
      // sync the client countdown to the server's remaining wait (max wins)
      // and let the ticking UI carry the message.
      const wait = Math.max(1, Number(out.retryInSeconds) || RESEND_COOLDOWN_S);
      setCooldown((current) => Math.max(current, wait));
      return;
    }
    if (out.code === 'NAME_UPDATE_LOCKED') { setPhase('locked'); return; }
    if (out.code === 'NAME_UPDATE_NOT_ELIGIBLE' || out.code === 'NAME_MISMATCH_NOT_RECORDED') {
      // Server gate says this session can't self-serve → back to the ID step.
      onExit(t('kiosk.nameUpdateNotEligible'));
      return;
    }
    setMsg(out.message || t('kiosk.genericError'));
  };

  const confirmCode = async () => {
    if (busy || code.length !== 6) return;
    setBusy(true); setMsg('');
    const out = await onConfirmCode(code);
    setBusy(false);
    setCode('');
    if (!out || out.code === 'FATAL' || out.code === 'STALE') return;
    if (out.ok && out.verified) { setPhase('success'); return; }
    if (out.code === 'NAME_UPDATE_LOCKED') { setPhase('locked'); return; }
    if (out.code === 'INVALID_CODE') {
      setMsg(Number.isFinite(Number(out.attemptsRemaining))
        ? t('kiosk.nameUpdateInvalidCodeAttempts', { count: Number(out.attemptsRemaining) })
        : t('kiosk.nameUpdateInvalidCode'));
      return;
    }
    if (out.code === 'CODE_EXPIRED') { setMsg(t('kiosk.nameUpdateExpired')); return; }
    if (out.code === 'CODE_NOT_SENT') { setPhase('send'); return; }
    if (out.ok && !out.verified) {
      // Rules (age/expiry) hard-stopped — shouldn't normally reach here from
      // a name-only mismatch; hand the guest to a person.
      onExit(t('kiosk.genericError'));
      return;
    }
    setMsg(out.message || t('kiosk.genericError'));
  };

  if (phase === 'locked') {
    return (
      <div className="kio-main center">
        <div className="kio-h2">{t('kiosk.nameUpdateLockedTitle')}</div>
        <p className="kio-sub">{t('kiosk.nameUpdateLockedBody')}</p>
        <div className="kio-row">
          <button type="button" className="kio-btn sm" onClick={onHelp}>🎧 {t('kiosk.getHelp')}</button>
          <button type="button" className="kio-btn ghost sm" onClick={() => onExit()}>‹ {t('kiosk.back')}</button>
        </div>
      </div>
    );
  }

  if (phase === 'success') {
    return (
      <div className="kio-main center">
        <div className="kio-h2">✓ {t('kiosk.nameUpdateSuccessTitle')}</div>
        <p className="kio-sub">{t('kiosk.nameUpdateSuccessBody')}</p>
      </div>
    );
  }

  if (phase === 'code') {
    const destinations = [sent?.email, sent?.sms].filter(Boolean).join(' · ');
    return (
      <div className="kio-main center">
        <div className="kio-h2">{t('kiosk.nameUpdateCodeTitle')}</div>
        <p className="kio-sub">
          {t('kiosk.nameUpdateSentTo', { destinations })}
        </p>
        <div className={`kio-field ${code ? '' : 'ph'}`} style={{ minWidth: 280, letterSpacing: '.35em' }}>
          {code || t('kiosk.pairPlaceholder')}
        </div>
        {/* Server resend cooldown (429 NAME_UPDATE_COOLDOWN) — inline, NOT a
            lockout. Ticks with the synced countdown. */}
        {cooldown > 0 ? (
          <div className="kio-sub" style={{ marginTop: 8, fontSize: 14 }}>{t('kiosk.nameUpdateCooldown', { count: cooldown })}</div>
        ) : null}
        <div className="kio-keypad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
            <button
              key={k}
              type="button"
              className="kio-key"
              onClick={() => { setMsg(''); if (code.length < 6) setCode((c) => c + k); }}
            >
              {k}
            </button>
          ))}
          <span />
          <button type="button" className="kio-key" onClick={() => { setMsg(''); if (code.length < 6) setCode((c) => `${c}0`); }}>0</button>
          <button type="button" className="kio-key" aria-label={t('kiosk.keypadDelete')} onClick={() => setCode((c) => c.slice(0, -1))}>⌫</button>
        </div>
        {msg ? <div className="kio-error">{msg}</div> : null}
        <div className="kio-row" style={{ marginTop: 16 }}>
          <button type="button" className="kio-btn" disabled={busy || code.length !== 6} onClick={confirmCode}>
            {t('kiosk.nameUpdateConfirmBtn')} ›
          </button>
          <button type="button" className="kio-btn ghost sm" disabled={busy || cooldown > 0} onClick={sendCode}>
            {cooldown > 0
              ? t('kiosk.nameUpdateResendIn', { count: cooldown })
              : t('kiosk.nameUpdateResend')}
          </button>
          {/* The "code never arrived" moment — hand off to a person. */}
          <button type="button" className="kio-btn ghost sm" disabled={busy} onClick={onHelp}>
            🎧 {t('kiosk.getHelp')}
          </button>
        </div>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="kio-btn back" disabled={busy} onClick={() => onExit()}>‹ {t('kiosk.back')}</button>
        </div>
      </div>
    );
  }

  // phase === 'send'
  const previewDestinations = [preview?.email, preview?.sms].filter(Boolean).join(' · ');
  return (
    <div className="kio-main center">
      <div className="kio-h2">{t('kiosk.nameUpdateTitle')}</div>
      <p className="kio-sub">{t('kiosk.nameUpdateIntro')}</p>
      {previewDestinations ? (
        <p className="kio-sub" style={{ fontWeight: 750, color: '#4c1d95', marginTop: -8 }}>
          {t('kiosk.nameUpdateWillGoTo', { destinations: previewDestinations })}
        </p>
      ) : null}
      {msg ? <div className="kio-error">{msg}</div> : null}
      {/* Server resend cooldown reached before a code screen (re-entry) —
          inline note, and the Send button is disabled until it elapses. */}
      {cooldown > 0 ? (
        <div className="kio-sub" style={{ fontSize: 14 }}>{t('kiosk.nameUpdateCooldown', { count: cooldown })}</div>
      ) : null}
      <div className="kio-row">
        <button type="button" className="kio-btn" disabled={busy || cooldown > 0} onClick={sendCode}>
          ✉️ {t('kiosk.nameUpdateSend')} ›
        </button>
        <button type="button" className="kio-btn ghost sm" disabled={busy} onClick={() => onExit()}>‹ {t('kiosk.back')}</button>
      </div>
    </div>
  );
}
