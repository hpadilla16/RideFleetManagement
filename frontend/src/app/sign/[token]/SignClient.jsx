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
 *   2. For each section: show body text + initial pad, post initial on
 *      tap-away.
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
import { api } from '../../../lib/client';

const LANG_KEY = 'ride-sign-lang';

const STRINGS = {
  en: {
    docTitle: 'Terms & Conditions',
    agreement: 'Agreement {n}',
    loading: 'Loading…',
    loadFailed: 'Failed to load',
    saveFailed: 'Save failed',
    completeFailed: 'Complete failed',
    thanks: 'Thanks! Return to your rental agent.',
    hint: 'Read each section, initial inside the box at the bottom, then sign at the bottom of this page.',
    sectionOf: 'Section {i} of {n}',
    initialed: '✓ Initialed',
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
    loadFailed: 'No se pudo cargar',
    saveFailed: 'No se pudo guardar',
    completeFailed: 'No se pudo completar',
    thanks: '¡Gracias! Regresa con tu agente de renta.',
    hint: 'Lee cada sección, pon tus iniciales en el recuadro y firma al final de esta página.',
    sectionOf: 'Sección {i} de {n}',
    initialed: '✓ Iniciales puestas',
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

export function SignClient({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
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
        setError(err?.message || null);
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
  if (error) return <ShellMessage tone="error">{error || t('loadFailed')}</ShellMessage>;
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
      <SignFlow token={token} data={data} t={t} onComplete={() => setCompleted(true)} onError={setError} />
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
    // The initial pad fires this when the customer lifts their finger
    // with a non-trivial drawing.
    if (!dataUrl || dataUrl.length < 200) return;
    try {
      await api(`/api/sign/${token}/initials`, {
        method: 'POST',
        body: JSON.stringify({ sectionKey, initialDataUrl: dataUrl }),
      });
      setSections((curr) => curr.map((s) => (s.key === sectionKey ? { ...s, signed: true } : s)));
    } catch (err) {
      onError(err?.message || t('saveFailed'));
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
      onError(err?.message || t('completeFailed'));
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
          {section.signed ? t('initialed') : t('initialHere')}
        </span>
        <InitialPad
          width={120} height={60}
          signed={section.signed}
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
// ---------------------------------------------------------------------------

function InitialPad({ width = 120, height = 60, signed, label, onChange }) {
  return <CanvasPad width={width} height={height} disabled={signed} label={label} onChange={onChange} />;
}

function SigPad({ height = 140, label, onChange }) {
  return <CanvasPad height={height} label={label} onChange={onChange} fullWidth />;
}

function CanvasPad({ width, height, fullWidth = false, disabled = false, label, onChange }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasContent, setHasContent] = useState(false);

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
    if (disabled) return;
    e.preventDefault();
    setDrawing(true);
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = (e) => {
    if (!drawing || disabled) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setHasContent(true);
  };
  const end = () => {
    if (!drawing) return;
    setDrawing(false);
    if (hasContent && onChange) {
      const dataUrl = canvasRef.current.toDataURL('image/png');
      onChange(dataUrl);
    }
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasContent(false);
    if (onChange) onChange('');
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <canvas
        ref={canvasRef}
        style={{
          border: `0.5px ${disabled ? 'solid #10B981' : 'dashed #9CA3AF'}`,
          borderRadius: 6,
          background: '#FFFFFF',
          touchAction: 'none',
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      {!disabled && hasContent && (
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

function ShellMessage({ children, tone = 'neutral' }) {
  const color = tone === 'error' ? '#B91C1C' : tone === 'ok' ? '#065F46' : '#374151';
  return (
    <div style={{ minHeight: '100vh', background: '#F9FAFB', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{
        background: '#FFFFFF', padding: 24, borderRadius: 12,
        maxWidth: 360, width: '100%', textAlign: 'center',
        border: '0.5px solid #E5E7EB',
      }}>
        <div style={{ color, fontSize: 15 }}>{children}</div>
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
