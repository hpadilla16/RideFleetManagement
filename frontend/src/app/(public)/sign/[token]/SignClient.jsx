'use client';

/**
 * Customer T&C signing page — opens on the customer's phone after they
 * scan the QR shown on the agent's screen (and customer display) in
 * step 2 of checkout-wizard-v2.
 *
 * NO auth — the token in the URL is the auth. Backend re-validates on
 * every endpoint call (kind = TERMS_SIGNING, not expired, not consumed).
 *
 * Flow:
 *   1. Load /api/sign/:token → { brand, signerLocale, sections[], … }
 *   2. For each section: show body text + initial pad, post the initial once
 *      drawing has settled (see INITIAL_COMMIT_DELAY_MS — an initial is
 *      several strokes, so a finger-lift is not the end of one).
 *   3. After all sections initialed, customer types name + draws full
 *      signature, taps Complete. Posts to /api/sign/:token/complete
 *      which stamps tcCompletedAt on the CheckoutSession.
 *   4. Agent screen polls the session 1.5s/cycle and advances to step 3
 *      automatically when tcCompletedAt becomes non-null.
 *
 * Phone-first layout — fluid full-width on narrow viewports, padded
 * card on wider. No nav chrome.
 *
 * WHOSE PAGE IS THIS? (gap #11, 2026-08-17)
 * ------------------------------------------------------------------
 * The renter has just scanned a QR off a stranger's counter screen. They
 * have no address bar context, no login, no logo — whatever this page says
 * is who they believe they are signing a contract with. It used to say
 * "Ride Fleet · Terms & Conditions": OUR name, on a contract between the
 * renter and (say) Autos del Valle, in a language nobody asked for.
 *
 * So identity comes first now, and it comes from the token payload
 * (`brand.companyName`, resolved server-side down the same cascade the
 * signed PDF header uses — see terms-signing.service.js resolveSigningBrand).
 * If every source is empty the header degrades to the plain document name.
 * It must never degrade to the platform's name.
 *
 * LANGUAGE
 * ------------------------------------------------------------------
 * Deliberately NOT the app's i18next instance: that reads
 * localStorage['ridefleet_lang'], which lives on the AGENT's device. This
 * page runs on the customer's own phone, where that key has never been
 * written — every customer would silently get the 'en' default. Resolution
 * order is signer's stored locale → their browser → English, with an
 * explicit toggle because the first two only ever guess. Same reasoning and
 * same shape as the public shuttle tracker (shuttle/[token]/TrackerClient.jsx).
 *
 * KNOWN LIMIT: only this page's CHROME is translated. The numbered section
 * bodies are the legal instrument and are served as-is from the backend
 * (terms-content.js is English-only, overridable per branch via
 * Location.termsSectionsJson). A Spanish-speaking renter therefore gets
 * Spanish instructions around English clauses until that content is
 * translated backend-side. Setting <html lang> correctly at least lets the
 * phone offer to translate the clauses.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../../lib/client';

const LANG_KEY = 'ride-sign-lang';

const STRINGS = {
  en: {
    docTitle: 'Terms & Conditions',
    agreement: 'Agreement {n}',
    loading: 'Loading…',
    loadFailedTitle: "We couldn't open your agreement",
    loadFailedBody: 'Ask your agent to show you the code again.',
    goneTitle: 'This link is no longer active',
    goneBody: 'Signing links are personal and they expire. Ask your agent for a new code.',
    tooFast: 'We received too many attempts in a row. Wait a minute, then open your link again.',
    saveFailed: 'Save failed',
    completeFailed: 'Complete failed',
    thanks: 'Thanks! Return to your rental agent.',
    hint: 'Read each section, initial inside the box at the bottom, then sign at the bottom of this page.',
    sectionOf: 'Section {i} of {n}',
    initialed: '✓ Initialed',
    savedRedo: 'Saved — draw again to redo',
    initialHere: 'Initial here →',
    typeName: 'Type your full name',
    namePlaceholder: 'First Last',
    signBelow: 'Sign in the box below',
    clear: 'Clear',
    submitting: 'Submitting…',
    complete: 'Complete ({done}/{total} initials)',
  },
  es: {
    docTitle: 'Términos y Condiciones',
    agreement: 'Contrato {n}',
    loading: 'Cargando…',
    loadFailedTitle: 'No pudimos abrir tu contrato',
    loadFailedBody: 'Pídele a tu agente que te muestre el código otra vez.',
    goneTitle: 'Este enlace ya no está activo',
    goneBody: 'Los enlaces para firmar son personales y expiran. Pídele a tu agente un código nuevo.',
    tooFast: 'Recibimos demasiados intentos seguidos. Espera un minuto y vuelve a abrir tu enlace.',
    saveFailed: 'No se pudo guardar',
    completeFailed: 'No se pudo completar',
    thanks: '¡Gracias! Regresa con tu agente de renta.',
    hint: 'Lee cada sección, pon tus iniciales en el recuadro y firma al final de esta página.',
    sectionOf: 'Sección {i} de {n}',
    initialed: '✓ Iniciales puestas',
    savedRedo: 'Guardado — dibuja de nuevo para rehacer',
    initialHere: 'Tus iniciales aquí →',
    typeName: 'Escribe tu nombre completo',
    namePlaceholder: 'Nombre y Apellido',
    signBelow: 'Firma en el recuadro',
    clear: 'Borrar',
    submitting: 'Enviando…',
    complete: 'Completar ({done}/{total} iniciales)',
  },
};

/** Narrow anything to a language this page actually ships strings for. */
function toSupportedLang(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s.startsWith('es')) return 'es';
  if (s.startsWith('en')) return 'en';
  return null;
}

/**
 * Resolve the page language for THIS phone.
 *
 * `signerLocale` arrives from the token payload and is the closest thing to
 * a real answer we have (it is the locale on the customer record). It only
 * takes effect once the payload lands, and never overrides a choice the
 * customer already made with the toggle.
 */
function useSignLang(signerLocale) {
  const [lang, setLangState] = useState('en');
  const [chosen, setChosen] = useState(false);

  useEffect(() => {
    const saved = toSupportedLang(typeof window !== 'undefined'
      ? (() => { try { return window.localStorage.getItem(LANG_KEY); } catch { return null; } })()
      : null);
    if (saved) { setLangState(saved); setChosen(true); return; }
    const fromBrowser = toSupportedLang(typeof navigator !== 'undefined' ? navigator.language : null);
    if (fromBrowser) setLangState(fromBrowser);
  }, []);

  useEffect(() => {
    if (chosen) return;
    const fromSigner = toSupportedLang(signerLocale);
    if (fromSigner) setLangState(fromSigner);
  }, [signerLocale, chosen]);

  // Keep <html lang> honest: it drives screen-reader pronunciation and the
  // browser's own "translate this page?" prompt, which is currently the only
  // route a Spanish speaker has to the English clause text.
  useEffect(() => {
    try { document.documentElement.lang = lang; } catch { /* non-DOM env */ }
  }, [lang]);

  const setLang = useCallback((next) => {
    setLangState(next);
    setChosen(true);
    try { window.localStorage.setItem(LANG_KEY, next); } catch { /* private browsing */ }
  }, []);

  const t = useCallback((key, vars = {}) => {
    let s = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  }, [lang]);

  return { t, lang, setLang };
}

/**
 * Why the customer never sees `err.message` here.
 *
 * lib/client.js builds `"<path> failed (<status>)"` whenever a response has no
 * JSON body of its own — which is exactly what an nginx 502/504 returns. On
 * this route the path CONTAINS THE TOKEN, so the failure state was printing
 * the customer's own credential back at them, in English, in the register of a
 * console log. That string is load-bearing for staff screens, which is why
 * client.js keeps producing it; the fix belongs on the one page whose paths
 * are secrets.
 *
 * Two failure shapes, because the customer's next move differs:
 *   'gone'   (404/410) — the link itself is finished. Only a new code helps.
 *   'failed' (anything else, including no network) — worth another try, and
 *            the agent still has the QR on screen.
 */
function classifyLoadError(err) {
  const status = Number(err?.status || 0);
  return status === 404 || status === 410 ? 'gone' : 'failed';
}

/**
 * Mid-flow failures still show whatever the SERVER said — "The signature is
 * blank — please sign before submitting" is a real instruction the customer
 * needs. Two kinds of message must never reach them anyway:
 *
 *   • anything the API client synthesised from the URL, because on this route
 *     the URL contains the token. This is the half of the token defence that
 *     runs mid-signature, after the customer has already started;
 *   • a 429, whose body is our rate limiter's internal bucket name in English
 *     ("Rate limit exceeded for terms-signing-write"). It carries no token and
 *     no leading slash, so it would sail straight through the check above and
 *     hand a Spanish-speaking renter the name of a guard they cannot act on.
 *
 * Exported for its own tests: this is the security-relevant half, and it is
 * not reachable from a jsdom render without driving a canvas.
 */
export function customerSafeMessage(err, { token, fallback, tooFast } = {}) {
  // `?? fallback`, not `&& tooFast`: a caller that forgets to pass a tooFast
  // string must not drop the 429 through to the checks below, where the
  // limiter's English bucket name ("Rate limit exceeded for
  // terms-signing-write") passes every one of them and reaches the renter.
  // The status alone is enough to know the body is unspeakable.
  if (Number(err?.status) === 429) return tooFast ?? fallback;
  const raw = String(err?.message || '').trim();
  if (!raw) return fallback;
  if (token && raw.includes(token)) return fallback;
  if (raw.startsWith('/api/')) return fallback;
  return raw;
}

export function SignClient({ token }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [flowError, setFlowError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [completed, setCompleted] = useState(false);
  const { t, lang, setLang } = useSignLang(data?.signerLocale);

  const companyName = String(data?.brand?.companyName || '').trim();

  // Load token + sections on mount.
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const json = await api(`/api/sign/${token}`, { bypassCache: true });
        setData(json);
      } catch (err) {
        setLoadError(classifyLoadError(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  /**
   * The tab title. Server-rendered metadata cannot know the tenant (the page
   * would have to fetch the token from the Next server, adding a failure mode
   * in front of a legal signature), so the branded title is applied here as
   * soon as the payload lands.
   *
   * Business identity ONLY. This string is public and cacheable — no signer
   * name, no plate, no amount, and deliberately not the agreement number.
   */
  useEffect(() => {
    const docTitle = t('docTitle');
    document.title = companyName ? `${companyName} · ${docTitle}` : docTitle;
  }, [companyName, t]);

  if (loading) return <ShellMessage>{t('loading')}</ShellMessage>;
  if (loadError) {
    // The toggle belongs on the dead end too: a Spanish speaker who lands on
    // an expired link would otherwise be told, in English, to go ask for a new
    // one. Same call as the public shuttle tracker's `gone` state.
    return (
      <ShellMessage tone="error" lang={lang} setLang={setLang}>
        <div style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>
          {t(loadError === 'gone' ? 'goneTitle' : 'loadFailedTitle')}
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#374151' }}>
          {t(loadError === 'gone' ? 'goneBody' : 'loadFailedBody')}
        </p>
      </ShellMessage>
    );
  }
  if (flowError) {
    return (
      <ShellMessage tone="error" lang={lang} setLang={setLang}>{flowError}</ShellMessage>
    );
  }
  if (completed) return <ShellMessage tone="ok">{t('thanks')}</ShellMessage>;
  if (!data) return null;

  return (
    <Shell
      companyName={companyName}
      title={t('docTitle')}
      subtitle={data.agreementNumber ? t('agreement', { n: data.agreementNumber }) : ''}
      lang={lang}
      setLang={setLang}
    >
      <SignFlow
        token={token}
        data={data}
        t={t}
        onComplete={() => setCompleted(true)}
        onError={setFlowError}
      />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Sign flow — walks through sections, then final signature
// ---------------------------------------------------------------------------

function SignFlow({ token, data, t, onComplete, onError }) {
  const [sections, setSections] = useState(data.sections);
  const [signerName, setSignerName] = useState('');
  const [finalSig, setFinalSig] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const allInitialed = sections.every((s) => s.signed);
  const canComplete = allInitialed && signerName.trim().length >= 2 && finalSig.length > 200;

  const onInitialChange = async (sectionKey, dataUrl) => {
    // Fires once the customer has stopped drawing for INITIAL_COMMIT_DELAY_MS
    // — after the LAST stroke of a multi-stroke initial, not the first.
    //
    // Re-entry is normal and safe: a renter redoing a section posts the same
    // sectionKey again, and saveInitial upserts on (agreementId, sectionKey).
    // Clearing the pad calls this with '' and is ignored below — the section
    // stays as saved as the server actually has it, rather than flipping to
    // unsigned and blocking Complete over a row that still exists.
    if (!dataUrl || dataUrl.length < 200) return;
    try {
      await api(`/api/sign/${token}/initials`, {
        method: 'POST',
        body: JSON.stringify({ sectionKey, initialDataUrl: dataUrl }),
      });
      setSections((curr) => curr.map((s) => (s.key === sectionKey ? { ...s, signed: true } : s)));
    } catch (err) {
      onError(customerSafeMessage(err, {
        token, fallback: t('saveFailed'), tooFast: t('tooFast'),
      }));
    }
  };

  const submitComplete = async () => {
    setSubmitting(true);
    try {
      await api(`/api/sign/${token}/complete`, {
        method: 'POST',
        body: JSON.stringify({ signatureDataUrl: finalSig, signerName: signerName.trim() }),
      });
      onComplete();
    } catch (err) {
      onError(customerSafeMessage(err, {
        token, fallback: t('completeFailed'), tooFast: t('tooFast'),
      }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <p style={hintTextStyle}>{t('hint')}</p>
      {sections.map((s, idx) => (
        <TermsSection
          key={s.key}
          index={idx + 1}
          total={sections.length}
          section={s}
          t={t}
          onInitial={(dataUrl) => onInitialChange(s.key, dataUrl)}
        />
      ))}
      <hr style={{ margin: '24px 0', border: 'none', borderTop: '0.5px solid #E5E7EB' }} />
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>{t('typeName')}</label>
        <input
          type="text"
          value={signerName}
          onChange={(e) => setSignerName(e.target.value)}
          placeholder={t('namePlaceholder')}
          style={inputStyle}
        />
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>{t('signBelow')}</label>
        <SigPad height={140} label={t('clear')} onChange={setFinalSig} />
      </div>
      <button
        style={{ ...primaryBtn, opacity: canComplete && !submitting ? 1 : 0.4 }}
        disabled={!canComplete || submitting}
        onClick={submitComplete}
      >
        {submitting
          ? t('submitting')
          : t('complete', { done: sections.filter((s) => s.signed).length, total: sections.length })}
      </button>
    </div>
  );
}

function TermsSection({ index, total, section, t, onInitial }) {
  return (
    <div style={{
      padding: 16, marginBottom: 12,
      background: section.signed ? '#ECFDF5' : '#FFFFFF',
      border: `0.5px solid ${section.signed ? '#10B981' : '#E5E7EB'}`,
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>
        {t('sectionOf', { i: index, n: total })}
      </div>
      <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 600 }}>
        {section.label}
      </h3>
      <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, margin: '0 0 12px' }}>
        {section.body}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <span style={{ fontSize: 12, color: '#6B7280' }}>
          {section.signed ? (
            <>
              {/* Still reads as done — but not as CLOSED. A renter who sees only
                  the ✓ assumes the box is finished with them; the second line is
                  the whole difference between "saved" and "frozen". */}
              <span style={{ color: '#047857', fontWeight: 600 }}>{t('initialed')}</span>
              <span style={{ display: 'block', fontSize: 11, marginTop: 2 }}>{t('savedRedo')}</span>
            </>
          ) : t('initialHere')}
        </span>
        <InitialPad
          width={120} height={60}
          saved={section.signed}
          label={t('clear')}
          onChange={onInitial}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny inline initial pad — narrower than SignaturePad, suits a phone
// in portrait. Reuses the same touch+mouse logic, no name field, no
// helper text.
//
// WHY THIS PAD WAITS AND THE SIGNATURE PAD DOES NOT (2026-08-26)
// ------------------------------------------------------------------
// An initial is not one stroke. "H.P." is four: two uprights, a bowl, two
// dots — with a finger-lift between every one of them. This pad used to
// commit on the FIRST lift, POST it, and then hand back `signed: true`,
// which arrived as `disabled` and made the canvas inert. The renter was
// left looking at half a letter with no Clear button (it rendered only
// while `!disabled`), no way to continue, and a green ✓ telling them it
// had gone through. Reported from the counter by the owner.
//
// So the commit is debounced past the gap BETWEEN strokes. 1400 ms: the
// natural pause while repositioning a finger is a few hundred ms, and a
// deliberate "I'm done" pause runs past a second, so the window sits well
// clear of the former and is still short enough that the ✓ lands before
// the renter has scrolled to the next section.
//
// The delay is opt-in per usage, not a property of the pad, because it buys
// nothing on the full signature at the bottom of the page. THAT onChange is
// `setFinalSig` — local state, no network, overwritten by every later
// stroke, and read only when Complete is tapped. Debouncing it would only
// add 1.4 s during which the customer has finished signing and the button
// is still disabled. The delay is here to defer a SIDE EFFECT; where there
// is none, commit immediately.
// ---------------------------------------------------------------------------

const INITIAL_COMMIT_DELAY_MS = 1400;

function InitialPad({ width = 120, height = 60, saved, label, onChange }) {
  return (
    <CanvasPad
      width={width}
      height={height}
      saved={saved}
      label={label}
      onChange={onChange}
      commitDelayMs={INITIAL_COMMIT_DELAY_MS}
    />
  );
}

function SigPad({ height = 140, label, onChange }) {
  return <CanvasPad height={height} label={label} onChange={onChange} fullWidth />;
}

/**
 * `saved` is PURELY cosmetic. It used to be `disabled` and gate `start()`,
 * which is what froze the pad; a saved initial must stay redrawable, because
 * the backend's saveInitial is an upsert keyed on (agreementId, sectionKey)
 * and a second POST simply overwrites the first.
 */
function CanvasPad({ width, height, fullWidth = false, saved = false, label, onChange, commitDelayMs = 0 }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  // Mirrors `hasContent` for the handlers to read. State alone is a race on a
  // quick tap-and-flick, where the pointerup handler can still be the one
  // built by the render BEFORE the first setHasContent(true) landed — and a
  // stroke that reads as empty never commits at all.
  const hasContentRef = useRef(false);
  const commitTimerRef = useRef(null);

  const cancelPendingCommit = () => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  };

  // A timer that outlives the page would POST for an unmounted section.
  useEffect(() => cancelPendingCommit, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const parent = canvas.parentElement;
      const w = fullWidth ? parent.clientWidth - 2 : width;
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = w + 'px';
      canvas.style.height = height + 'px';
      canvas.width = w * dpr;
      canvas.height = height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, w, height);
      ctx.strokeStyle = '#1F2937';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [width, height, fullWidth]);

  const pointFromEvent = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const t = e.touches?.[0];
    const clientX = t ? t.clientX : e.clientX;
    const clientY = t ? t.clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const start = (e) => {
    e.preventDefault();
    // The next stroke of the same initial — whatever was about to be sent is
    // now a half-drawing. This is the line that makes "H.P." possible.
    cancelPendingCommit();
    setDrawing(true);
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!hasContentRef.current) {
      hasContentRef.current = true;
      setHasContent(true);
    }
  };
  const end = () => {
    if (!drawing) return;
    setDrawing(false);
    if (!hasContentRef.current || !onChange) return;
    // Read the canvas when the timer FIRES, not now: by then it carries every
    // stroke, and a Clear in the meantime cancels this outright.
    const commit = () => {
      commitTimerRef.current = null;
      onChange(canvasRef.current.toDataURL('image/png'));
    };
    if (!commitDelayMs) return commit();
    cancelPendingCommit();
    commitTimerRef.current = setTimeout(commit, commitDelayMs);
  };

  const clear = () => {
    // Without this, a pending commit fires a moment later and reads the canvas
    // it finds — the blank one — POSTing an empty initial over a good saved
    // one. saveInitial has no ink check; `complete` is the only blank guard.
    cancelPendingCommit();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    hasContentRef.current = false;
    setHasContent(false);
    if (onChange) onChange('');
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <canvas
        ref={canvasRef}
        style={{
          // Green + solid still reads "done". The 0.5 opacity that used to come
          // with it read "closed", which is the impression the fix removes —
          // the ink stays as crisp as it was before it saved.
          border: `0.5px ${saved ? 'solid #10B981' : 'dashed #9CA3AF'}`,
          borderRadius: 6,
          background: '#FFFFFF',
          touchAction: 'none',
        }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      {/* `saved` keeps the button up after a reload, when the section is
          already initialed server-side but this canvas starts empty. */}
      {(hasContent || saved) && (
        <button onClick={clear} style={clearBtnStyle}>{label}</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * Header order is the point of gap #11: WHO first, WHAT second, WHICH third.
 * `companyName` is the renting business; when it is missing the document name
 * is promoted rather than showing any platform branding in its place.
 */
function Shell({ companyName, title, subtitle, lang, setLang, children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#F9FAFB', padding: '16px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <div style={{
          marginBottom: 16, padding: '12px 4px', display: 'flex',
          alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            {companyName ? (
              <>
                <div style={{ fontWeight: 700, fontSize: 18, color: '#111827', overflowWrap: 'anywhere' }}>
                  {companyName}
                </div>
                <div style={{ color: '#374151', fontSize: 14, marginTop: 2 }}>{title}</div>
              </>
            ) : (
              <div style={{ fontWeight: 700, fontSize: 18, color: '#111827' }}>{title}</div>
            )}
            {subtitle && <div style={{ color: '#6B7280', fontSize: 13, marginTop: 2 }}>{subtitle}</div>}
          </div>
          {setLang && <LangToggle lang={lang} setLang={setLang} />}
        </div>
        {children}
      </div>
    </div>
  );
}

function LangToggle({ lang, setLang }) {
  return (
    <div style={{ display: 'flex', flexShrink: 0, border: '0.5px solid #D1D5DB', borderRadius: 6, overflow: 'hidden' }}>
      {['es', 'en'].map((code) => (
        <button
          key={code}
          onClick={() => setLang(code)}
          aria-pressed={lang === code}
          style={{
            padding: '4px 10px', fontSize: 12, cursor: 'pointer', border: 'none',
            background: lang === code ? '#1F2937' : '#FFFFFF',
            color: lang === code ? '#FFFFFF' : '#6B7280',
          }}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function ShellMessage({ children, tone = 'neutral', lang, setLang }) {
  const color = tone === 'error' ? '#B91C1C' : tone === 'ok' ? '#065F46' : '#374151';
  return (
    <div style={{ minHeight: '100vh', background: '#F9FAFB', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{
        background: '#FFFFFF', padding: 24, borderRadius: 12,
        maxWidth: 360, width: '100%', textAlign: 'center',
        border: '0.5px solid #E5E7EB',
      }}>
        <div style={{ color, fontSize: 15 }}>{children}</div>
        {setLang && (
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
            <LangToggle lang={lang} setLang={setLang} />
          </div>
        )}
      </div>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: 12, color: '#6B7280', marginBottom: 4 };
const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 15,
  border: '0.5px solid #D1D5DB', borderRadius: 6, boxSizing: 'border-box',
};
const primaryBtn = {
  width: '100%', padding: '14px', background: '#1F2937', color: '#FFFFFF',
  border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 500, cursor: 'pointer',
};
const hintTextStyle = { fontSize: 13, color: '#6B7280', margin: '0 0 16px' };
const clearBtnStyle = {
  position: 'absolute', top: 2, right: 2, fontSize: 10,
  background: 'rgba(255,255,255,0.95)', border: '0.5px solid #D1D5DB',
  padding: '2px 6px', borderRadius: 4, cursor: 'pointer',
};
