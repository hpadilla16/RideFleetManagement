'use client';

/**
 * Ride Kiosk — B3c Staff Assist (mockups K-S1..S3, Hector-approved).
 *
 * Guest stuck at the ID step → a STAFF member authenticates at the kiosk
 * with their existing lock-PIN (K-S1), manually types the guest's ID fields
 * and captures license FRONT + BACK photos (K-S2), and the server performs
 * an AUDITED bypass of the scan step (K-S3). The rules are never bypassed —
 * age/expiry run server-side exactly like the guest path (underage stays a
 * hard stop with staff standing right there).
 *
 * This screen is employee-facing: unlike the guest confirm panel, staff CAN
 * type into the fields. All API calls flow through the parent's handlers
 * (kioskClient seam + stale-guard + routeFatal stay in one place).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CAMERA_ERR_IN_FLIGHT, acquireCameraStream, cameraGrantedOnce } from '../../lib/kioskCamera';

const FIELD_DEFS = [
  { key: 'firstName', labelKey: 'kiosk.assistFirstName' },
  { key: 'lastName', labelKey: 'kiosk.assistLastName' },
  { key: 'dateOfBirth', labelKey: 'kiosk.idPhotoFieldDob', type: 'date' },
  { key: 'licenseNumber', labelKey: 'kiosk.idPhotoFieldLicense' },
  { key: 'licenseState', labelKey: 'kiosk.idPhotoFieldState' },
  { key: 'licenseExpiry', labelKey: 'kiosk.idPhotoFieldExpiry', type: 'date' },
];

// Staff-assist failures carry only the rule reasons (never NAME_MISMATCH —
// the staff member is holding the physical license).
const REASON_KEYS = {
  UNDERAGE: 'kiosk.reasonUnderage',
  AGE_ABOVE_MAX: 'kiosk.reasonAgeAboveMax',
  DOB_UNREADABLE: 'kiosk.reasonDobUnreadable',
  DOB_IMPLAUSIBLE: 'kiosk.reasonDobImplausible',
  LICENSE_EXPIRY_UNREADABLE: 'kiosk.reasonExpiryUnreadable',
  LICENSE_EXPIRES_BEFORE_RETURN: 'kiosk.reasonExpiresBeforeReturn',
};

function grantTimeLeft(expiresAt) {
  const ms = Math.max(0, new Date(expiresAt || 0).getTime() - Date.now());
  const totalSecs = Math.floor(ms / 1000);
  return { ms, label: `${Math.floor(totalSecs / 60)}:${String(totalSecs % 60).padStart(2, '0')}` };
}

export function StaffAssistScreen({ t, prefillFields, onList, onUnlock, onVerify, onCompleted, onExit }) {
  const [phase, setPhase] = useState('unlock'); // unlock | locked | form | success
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [staff, setStaff] = useState(null); // null = loading
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [grant, setGrant] = useState(null); // {userId, name, expiresAt}
  const [clock, setClock] = useState(0); // re-render tick for the grant chip
  const [fields, setFields] = useState(() => ({
    firstName: '', lastName: '', dateOfBirth: '', licenseNumber: '', licenseState: '', licenseExpiry: '',
    ...(prefillFields || {}),
  }));
  const [photos, setPhotos] = useState({ front: null, back: null });
  const [activeCapture, setActiveCapture] = useState(null); // 'front' | 'back' | null
  const [verifyFail, setVerifyFail] = useState(null); // {failureReasons, minimumAge, maximumAge}

  // ── K-S1: staff list ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = await onList();
      if (cancelled) return;
      if (out.ok) {
        setStaff(out.staff);
        const first = out.staff.find((s) => s.hasPin);
        if (first) setUserId(first.id);
      } else if (out.code === 'NOT_ASSISTABLE') {
        onExit();
      } else if (out.code !== 'FATAL') {
        setStaff([]);
        setMsg(out.message || t('kiosk.genericError'));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Grant chip countdown + client-side expiry hygiene (server enforces the
  // real 10-min TTL; this just keeps the UI honest).
  useEffect(() => {
    if (phase !== 'form' || !grant) return undefined;
    const timer = setInterval(() => {
      setClock((n) => n + 1);
      if (grantTimeLeft(grant.expiresAt).ms <= 0) {
        setGrant(null);
        setPin('');
        setMsg(t('kiosk.assistGrantExpired'));
        setPhase('unlock');
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, grant, t]);

  const submitUnlock = async () => {
    if (!userId || pin.length < 4 || busy) return;
    setBusy(true); setMsg('');
    const out = await onUnlock(userId, pin);
    setBusy(false);
    setPin('');
    if (out.ok) {
      setGrant(out.grant);
      setMsg('');
      setPhase('form');
      return;
    }
    if (out.code === 'FATAL') return;
    if (out.code === 'STAFF_ASSIST_LOCKED') { setPhase('locked'); return; }
    if (out.code === 'INVALID_PIN') {
      setMsg(Number.isFinite(Number(out.attemptsRemaining))
        ? t('kiosk.assistPinInvalidAttempts', { count: Number(out.attemptsRemaining) })
        : t('kiosk.assistPinInvalid'));
      return;
    }
    if (out.code === 'NO_PIN_SET') { setMsg(t('kiosk.assistNoPinErr')); return; }
    if (out.code === 'STAFF_NOT_FOUND') { setMsg(t('kiosk.assistStaffNotFound')); return; }
    if (out.code === 'NOT_ASSISTABLE') { onExit(); return; }
    setMsg(out.message || t('kiosk.genericError'));
  };

  const submitVerify = async () => {
    if (busy) return;
    if (!photos.front || !photos.back) { setMsg(t('kiosk.assistBothPhotos')); return; }
    setBusy(true); setMsg(''); setVerifyFail(null);
    const out = await onVerify({
      fields,
      licenseFrontPhoto: photos.front,
      licenseBackPhoto: photos.back,
    });
    setBusy(false);
    if (out.code === 'FATAL') return;
    if (out.code === 'ASSIST_GRANT_REQUIRED') {
      // Grant died server-side → leave the assist flow cleanly.
      onExit(t('kiosk.assistGrantExpired'));
      return;
    }
    if (out.code === 'MISSING_PHOTO' || out.code === 'INVALID_PHOTO') {
      setMsg(t(out.code === 'MISSING_PHOTO' ? 'kiosk.assistBothPhotos' : 'kiosk.invalidPhoto'));
      return;
    }
    if (!out.ok) { setMsg(out.message || t('kiosk.genericError')); return; }
    if (out.verified) { setPhase('success'); return; }
    // Rules said no (underage / expired) — session stays escalated; staff can
    // fix a typo in the fields or end the assist.
    setVerifyFail({
      failureReasons: out.failureReasons || [],
      minimumAge: out.minimumAge,
      maximumAge: out.maximumAge,
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  if (phase === 'locked') {
    return (
      <div className="kio-main center">
        <div className="kio-h2">{t('kiosk.assistLockedTitle')}</div>
        <p className="kio-sub">{t('kiosk.assistLockedBody')}</p>
        <button type="button" className="kio-btn ghost sm" onClick={() => onExit()}>‹ {t('kiosk.assistCancel')}</button>
      </div>
    );
  }

  if (phase === 'success') {
    return (
      <div className="kio-main center">
        <div className="kio-h2">✓ {t('kiosk.assistSuccessTitle')}</div>
        <p className="kio-sub">{t('kiosk.assistSuccessBody', { name: grant?.name || '' })}</p>
        <button type="button" className="kio-btn" disabled={busy} onClick={onCompleted}>
          {t('kiosk.assistContinueGuest')} ›
        </button>
      </div>
    );
  }

  if (phase === 'form') {
    const left = grant ? grantTimeLeft(grant.expiresAt) : { label: '0:00' };
    return (
      <div className="kio-main">
        <div className="kio-h2" style={{ fontSize: 24 }}>{t('kiosk.assistFormTitle')}</div>
        <div className="kio-row" style={{ marginBottom: 12 }}>
          <span
            className="kio-paystate ok"
            title={t('kiosk.assistGrantChipTitle')}
            data-clock={clock /* re-render tick */}
          >
            🔓 {t('kiosk.assistGrantChip', { name: grant?.name || '', time: left.label })}
          </span>
        </div>

        <div className="kio-panel" style={{ maxWidth: 640 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {FIELD_DEFS.map((def) => (
              <label key={def.key} style={{ textAlign: 'left', fontSize: 13, fontWeight: 700, color: '#6f668f' }}>
                {t(def.labelKey)}
                <input
                  className="kio-input"
                  type={def.type || 'text'}
                  value={fields[def.key] || ''}
                  autoComplete="off"
                  style={{ marginTop: 4, fontSize: 16 }}
                  onChange={(e) => setFields((cur) => ({ ...cur, [def.key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="kio-row" style={{ marginTop: 14, alignItems: 'stretch' }}>
          <PhotoBox
            t={t}
            label={t('kiosk.assistFront')}
            value={photos.front}
            active={activeCapture === 'front'}
            onOpen={() => setActiveCapture('front')}
            onCaptured={(dataUrl) => { setPhotos((cur) => ({ ...cur, front: dataUrl })); setActiveCapture(null); }}
            onCancel={() => setActiveCapture(null)}
          />
          <PhotoBox
            t={t}
            label={t('kiosk.assistBack')}
            value={photos.back}
            active={activeCapture === 'back'}
            onOpen={() => setActiveCapture('back')}
            onCaptured={(dataUrl) => { setPhotos((cur) => ({ ...cur, back: dataUrl })); setActiveCapture(null); }}
            onCancel={() => setActiveCapture(null)}
          />
        </div>

        {verifyFail ? (
          <div className="kio-panel" style={{ maxWidth: 640, marginTop: 12 }}>
            <div style={{ fontSize: 13.5, color: '#be123c', fontWeight: 700 }}>
              {(verifyFail.failureReasons || []).map((code) => (
                <div key={code}>
                  {t(REASON_KEYS[code] || 'kiosk.reasonGeneric', {
                    age: code === 'AGE_ABOVE_MAX' ? (verifyFail.maximumAge ?? '') : (verifyFail.minimumAge ?? ''),
                  })}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12.5, color: '#6f668f', marginTop: 6 }}>{t('kiosk.assistCorrectHint')}</div>
          </div>
        ) : null}
        {msg ? <div className="kio-error">{msg}</div> : null}

        <div className="kio-row" style={{ marginTop: 16 }}>
          <button type="button" className="kio-btn sm" disabled={busy || !photos.front || !photos.back} onClick={submitVerify}>
            {t('kiosk.assistVerifyBtn')} ›
          </button>
          <button type="button" className="kio-btn ghost sm" disabled={busy} onClick={() => onExit()}>
            {t('kiosk.assistEndBtn')}
          </button>
        </div>
      </div>
    );
  }

  // ── K-S1: unlock ────────────────────────────────────────────────────────────
  const selected = (staff || []).find((s) => s.id === userId);
  return (
    <div className="kio-main center">
      <div className="kio-h2">{t('kiosk.assistTitle')}</div>
      <p className="kio-sub">{t('kiosk.assistSub')}</p>
      {staff === null ? (
        <p className="kio-sub">{t('kiosk.loading')}</p>
      ) : (
        <>
          <select
            className="kio-input"
            style={{ maxWidth: 340, textAlign: 'center', fontWeight: 700 }}
            value={userId}
            onChange={(e) => { setUserId(e.target.value); setMsg(''); }}
          >
            <option value="">{t('kiosk.assistPickName')}</option>
            {staff.map((member) => (
              <option key={member.id} value={member.id} disabled={!member.hasPin}>
                {member.name}{member.hasPin ? '' : ` — ${t('kiosk.assistNoPinHint')}`}
              </option>
            ))}
          </select>
          <div className={`kio-field ${pin ? '' : 'ph'}`} style={{ marginTop: 14, minWidth: 240, letterSpacing: '.4em' }}>
            {pin ? '● '.repeat(pin.length).trim() : '• • • •'}
          </div>
          <div className="kio-keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
              <button key={k} type="button" className="kio-key" onClick={() => { setMsg(''); if (pin.length < 8) setPin((p) => p + k); }}>{k}</button>
            ))}
            <span />
            <button type="button" className="kio-key" onClick={() => { setMsg(''); if (pin.length < 8) setPin((p) => `${p}0`); }}>0</button>
            <button type="button" className="kio-key" aria-label={t('kiosk.keypadDelete')} onClick={() => setPin((p) => p.slice(0, -1))}>⌫</button>
          </div>
          {selected && !selected.hasPin ? <div className="kio-error">{t('kiosk.assistNoPinErr')}</div> : null}
          {msg ? <div className="kio-error">{msg}</div> : null}
          <div className="kio-row" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="kio-btn sm"
              disabled={busy || !userId || pin.length < 4 || (selected && !selected.hasPin)}
              onClick={submitUnlock}
            >
              {t('kiosk.assistUnlockBtn')} ›
            </button>
            <button type="button" className="kio-btn ghost sm" disabled={busy} onClick={() => onExit()}>
              {t('kiosk.assistCancel')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * K-S2 capture box: thumbnail once captured; tap → simple live preview with
 * tap-to-capture (staff-operated, no countdown needed) + an always-available
 * upload fallback. Mirrored preview / raw frame, same as the guest paths.
 */
function PhotoBox({ t, label, value, active, onOpen, onCaptured, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);
  const activeRef = useRef(false);
  const unmountedRef = useRef(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [failed, setFailed] = useState(false);
  // Raw getUserMedia error name — remote-debug line (iPad re-test).
  const [camDiag, setCamDiag] = useState('');

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  const stopCam = useCallback(() => {
    try { streamRef.current?.getTracks?.().forEach((track) => track.stop()); } catch {}
    streamRef.current = null;
    if (videoRef.current) {
      try { videoRef.current.pause(); } catch {}
      try { videoRef.current.srcObject = null; } catch {}
    }
    setCameraOn(false);
  }, []);

  // Shared hardened acquisition (gesture-safe, single in-flight, orphan
  // cleanup when the box closed / component unmounted mid-prompt).
  const startCam = useCallback(async () => {
    setFailed(false);
    setCamDiag('');
    const out = await acquireCameraStream({
      facingMode: 'user',
      isCancelled: () => unmountedRef.current || !activeRef.current,
    });
    if (out.error) {
      if (out.error.name === CAMERA_ERR_IN_FLIGHT || out.error.name === 'Cancelled') return;
      setFailed(true);
      setCamDiag(out.error.name + (out.error.message ? `: ${out.error.message}` : ''));
      return;
    }
    streamRef.current = out.stream;
    setCameraOn(true);
    setTimeout(() => {
      if (videoRef.current && streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
        videoRef.current.play().catch(() => {});
      }
    }, 0);
  }, []);

  // Opening the box is itself a tap — the tap handler below calls startCam
  // directly (gesture context). This effect only handles teardown + the
  // fast-path re-start once a camera already succeeded this session.
  useEffect(() => {
    if (!active) { stopCam(); return undefined; }
    if (!streamRef.current && cameraGrantedOnce()) startCam();
    return () => stopCam();
  }, [active, startCam, stopCam]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const scale = Math.min(1, 1600 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    let dataUrl = null;
    try { dataUrl = canvas.toDataURL('image/jpeg', 0.9); } catch { dataUrl = null; }
    stopCam();
    if (dataUrl) onCaptured(dataUrl);
  };

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { stopCam(); onCaptured(String(reader.result)); };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div style={{ width: 240 }}>
      {active ? (
        <div className="kio-scanbox" style={{ width: '100%', minHeight: 150, padding: 0, overflow: 'hidden' }}>
          {cameraOn ? (
            // min-height + black bg: a stalled stream is a visible black box,
            // never a 0-height invisible element (iPad debug).
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              ref={videoRef}
              muted
              playsInline
              style={{ width: '100%', minHeight: 140, background: '#000', transform: 'scaleX(-1)' }}
              onLoadedMetadata={(e) => {
                if (!e.currentTarget.videoWidth) setCamDiag('loadedmetadata: videoWidth=0');
              }}
            />
          ) : failed ? (
            // Gesture-driven retry.
            <button type="button" className="kio-btn back" onClick={startCam}>📷 {t('kiosk.tryAgain')}</button>
          ) : (
            <span style={{ fontSize: 26 }}>📷</span>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="kio-scanbox"
          style={{ width: '100%', minHeight: 150, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}
          onClick={() => {
            // Gesture-initiated start: flip the ref NOW (state lands next
            // render) so the helper's isCancelled doesn't kill the stream,
            // then call getUserMedia inside this same tap.
            activeRef.current = true;
            onOpen();
            startCam();
          }}
        >
          {value ? (
            <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: 110, borderRadius: 10 }} />
          ) : (
            <span style={{ fontSize: 26 }}>📷</span>
          )}
          <span>{label}{value ? ' ✓' : ` — ${t('kiosk.assistTapCapture')}`}</span>
        </button>
      )}
      <div className="kio-row" style={{ marginTop: 8 }}>
        {active ? (
          <>
            <button type="button" className="kio-btn sm" style={{ minWidth: 0 }} disabled={!cameraOn} onClick={capture}>
              📸 {t('kiosk.assistCaptureBtn')}
            </button>
            <button type="button" className="kio-btn back" aria-label={t('kiosk.closeCamera')} onClick={() => { stopCam(); onCancel(); }}>✕</button>
          </>
        ) : (
          <button type="button" className="kio-btn back" onClick={() => fileRef.current?.click()}>
            ⬆ {t('kiosk.assistUpload')}
          </button>
        )}
      </div>
      {failed && active ? (
        <div className="kio-error" style={{ fontSize: 12.5 }}>
          {t('kiosk.idPhotoCameraFailed')}
          {camDiag ? (
            <div style={{ fontSize: 11, color: '#6f668f', fontWeight: 600, marginTop: 3 }}>{camDiag}</div>
          ) : null}
        </div>
      ) : null}
      {!failed && camDiag && active ? (
        <div style={{ fontSize: 11, color: '#6f668f', fontWeight: 600, marginTop: 4 }}>{camDiag}</div>
      ) : null}
      {/* Staff photographs a PHYSICAL license card → rear camera hint
          (unlike the guest selfie, which stays capture="user"). */}
      <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onFile} />
    </div>
  );
}
