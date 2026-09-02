'use client';

/**
 * QR self-return — the customer-facing page (Hector, 2026-09-02).
 *
 * The poster in the return area says "¿Devolviste el carro? Marca aquí" and
 * its QR opens this page. The customer types their reservation number + last
 * name and taps the button; the server stamps the moment as evidence for
 * check-in (late fees stop accruing at that hour when the counter is slow).
 *
 * CONTRACT:
 *  - GET  /api/public/self-return/<token>          → { locationName } | 404
 *  - POST /api/public/self-return/<token>/submit   → { ok, already, reportedAt }
 *    Any mismatch (number, last name, not an open rental) is the SAME
 *    generic 404 the dead-token page gets — this page turns the submit 404
 *    into "check your number and last name", never into an oracle.
 *
 * LANGUAGE: ES-primary (customers in PR), explicit ES | EN toggle — the
 * same STRINGS pattern as DriverClient/TrackerClient.
 */
import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../../../lib/client';

const LANG_KEY = 'ride-self-return-lang';

const STRINGS = {
  es: {
    title: '¿Devolviste el carro?',
    subtitle: 'Marca aquí la devolución',
    loading: 'Cargando…',
    deadTitle: 'Este código no está activo',
    deadBody: 'Pregunta en el counter. · This code is not active — ask at the counter.',
    intro: 'Entra tu número de reservación y tu apellido. Registramos la hora exacta en que entregaste el carro.',
    resLabel: 'Número de reservación',
    resPlaceholder: 'p. ej. R-12345',
    nameLabel: 'Apellido',
    namePlaceholder: 'como aparece en la reservación',
    submit: 'Devolví el carro ✓',
    sending: 'Enviando…',
    notFound: 'No encontramos esa reservación con ese apellido. Verifica el número y el apellido e intenta de nuevo — o pregunta en el counter.',
    failed: 'No se pudo enviar — intenta de nuevo.',
    doneTitle: '¡Devolución registrada!',
    doneBody: 'Registramos tu devolución a las {time}. Deja las llaves según las instrucciones del local y ¡buen viaje!',
    alreadyTitle: 'Ya estaba registrada',
    alreadyBody: 'Tu devolución ya quedó marcada a las {time}. No tienes que hacer nada más.',
    markAnother: 'Marcar otra reservación',
    privacy: 'Solo registramos la hora de tu devolución. El check-in final lo hace el personal.',
  },
  en: {
    title: 'Returned the car?',
    subtitle: 'Mark your return here',
    loading: 'Loading…',
    deadTitle: 'This code is not active',
    deadBody: 'Ask at the counter. · Este código no está activo — pregunta en el counter.',
    intro: 'Enter your reservation number and your last name. We record the exact time you handed the car back.',
    resLabel: 'Reservation number',
    resPlaceholder: 'e.g. R-12345',
    nameLabel: 'Last name',
    namePlaceholder: 'as it appears on the reservation',
    submit: 'I returned the car ✓',
    sending: 'Sending…',
    notFound: 'We could not find that reservation with that last name. Check the number and last name and try again — or ask at the counter.',
    failed: "It didn't go through — please try again.",
    doneTitle: 'Return recorded!',
    doneBody: 'We recorded your return at {time}. Leave the keys per the location instructions — safe travels!',
    alreadyTitle: 'Already recorded',
    alreadyBody: 'Your return was already marked at {time}. Nothing else to do.',
    markAnother: 'Mark another reservation',
    privacy: 'We only record the time of your return. Staff complete the final check-in.',
  },
};

function useStrings() {
  const [lang, setLangState] = useState('es');
  useEffect(() => {
    let saved = null;
    try { saved = window.localStorage.getItem(LANG_KEY); } catch { saved = null; }
    if (saved === 'es' || saved === 'en') { setLangState(saved); return; }
    const nav = String(navigator.language || 'es').toLowerCase();
    setLangState(nav.startsWith('en') ? 'en' : 'es');
  }, []);
  const setLang = useCallback((next) => {
    setLangState(next);
    try { window.localStorage.setItem(LANG_KEY, next); } catch { /* private browsing */ }
  }, []);
  const t = useCallback((key, vars = {}) => {
    let s = STRINGS[lang][key] || STRINGS.es[key] || key;
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  }, [lang]);
  return { t, lang, setLang };
}

export function ReturnClient({ token }) {
  const { t, lang, setLang } = useStrings();
  const [ctx, setCtx] = useState(null);       // { locationName } — last good context
  const [gone, setGone] = useState(false);    // bare 404 on the context — dead QR
  const [loadingCtx, setLoadingCtx] = useState(true);
  const [resNum, setResNum] = useState('');
  const [lastName, setLastName] = useState('');
  // idle | sending | done | already
  const [phase, setPhase] = useState('idle');
  const [reportedAt, setReportedAt] = useState(null);
  // null | 'notFound' | 'failed'
  const [err, setErr] = useState(null);

  const api = useCallback((path) => `${API_BASE}/api/public/self-return/${encodeURIComponent(token)}${path}`, [token]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(api(''), { cache: 'no-store' });
        if (!alive) return;
        if (res.status === 404) { setGone(true); return; }
        if (!res.ok) throw new Error(String(res.status));
        setCtx(await res.json());
      } catch { /* transient — the form still renders with a generic header */ }
      finally { if (alive) setLoadingCtx(false); }
    })();
    return () => { alive = false; };
  }, [api]);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (phase === 'sending') return;
    setErr(null);
    setPhase('sending');
    try {
      const res = await fetch(api('/submit'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationNumber: resNum.trim(), lastName: lastName.trim() }),
      });
      if (res.status === 404) {
        // Same generic 404 for a dead token and a pair mismatch — a live
        // context means the token worked seconds ago, so read it as mismatch.
        if (ctx) { setErr('notFound'); setPhase('idle'); } else { setGone(true); }
        return;
      }
      if (!res.ok) { setErr('failed'); setPhase('idle'); return; }
      const out = await res.json();
      setReportedAt(out?.reportedAt || null);
      setPhase(out?.already === true ? 'already' : 'done');
    } catch { setErr('failed'); setPhase('idle'); }
  };

  const timeLabel = reportedAt
    ? new Date(reportedAt).toLocaleTimeString(lang === 'es' ? 'es-PR' : 'en-US', { hour: 'numeric', minute: '2-digit' })
    : '';

  const S = {
    page: { minHeight: '100dvh', display: 'flex', flexDirection: 'column', background: '#f4f2f7', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#2a2333' },
    bar: { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', background: '#2a2333', color: '#fff' },
    barTitle: { fontSize: 16, fontWeight: 800, lineHeight: 1.25 },
    barSub: { fontSize: 12, fontWeight: 600, color: '#cfc9dd', lineHeight: 1.3 },
    langWrap: { display: 'flex', border: '1px solid #57506a', borderRadius: 999, overflow: 'hidden', flexShrink: 0, marginLeft: 'auto' },
    langBtn: (active) => ({ minHeight: 32, padding: '4px 10px', fontSize: 11.5, fontWeight: 700, border: 'none', cursor: 'pointer', background: active ? '#5b21b6' : 'transparent', color: '#fff' }),
    body: { flex: 1, padding: '18px 16px 28px', maxWidth: 480, width: '100%', margin: '0 auto', boxSizing: 'border-box' },
    card: { background: '#fff', borderRadius: 16, padding: 18, boxShadow: '0 1px 6px rgba(0,0,0,.06)' },
    note: { fontSize: 14.5, lineHeight: 1.5, color: '#5b5266', margin: '8px 0 0' },
    label: { display: 'block', fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5b5266', fontWeight: 700, margin: '16px 0 5px' },
    input: { width: '100%', minHeight: 50, padding: '12px 13px', fontSize: 17, borderRadius: 12, border: '1.5px solid #ddd6ea', background: '#fff', color: '#2a2333', boxSizing: 'border-box', fontFamily: 'inherit' },
    btn: (disabled) => ({ marginTop: 18, width: '100%', minHeight: 54, padding: '14px 16px', fontSize: 17, fontWeight: 800, color: '#fff', background: '#0f8a68', opacity: disabled ? 0.6 : 1, border: 'none', borderRadius: 13, cursor: disabled ? 'default' : 'pointer' }),
    ghostBtn: { marginTop: 12, width: '100%', minHeight: 46, fontSize: 14.5, fontWeight: 700, color: '#5b21b6', background: 'none', border: 'none', cursor: 'pointer' },
    err: { marginTop: 12, padding: '11px 13px', background: '#fdecea', color: '#8f2a23', borderRadius: 11, fontSize: 14.5, lineHeight: 1.45, fontWeight: 600 },
    center: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' },
    bigIcon: { fontSize: 46 },
    doneTitle: { fontSize: 21, fontWeight: 800, marginTop: 12 },
  };

  const langToggle = (
    <div style={S.langWrap} role="group" aria-label="Language">
      <button type="button" style={S.langBtn(lang === 'es')} onClick={() => setLang('es')} aria-pressed={lang === 'es'}>ES</button>
      <button type="button" style={S.langBtn(lang === 'en')} onClick={() => setLang('en')} aria-pressed={lang === 'en'}>EN</button>
    </div>
  );

  if (gone) {
    return (
      <div style={S.page}>
        <div style={S.center}>
          <div style={S.bigIcon}>🔑</div>
          <h1 style={{ margin: '12px 0 0', fontSize: 19, fontWeight: 800 }}>{t('deadTitle')}</h1>
          <p style={{ ...S.note, maxWidth: 420 }}>{t('deadBody')}</p>
          <div style={{ marginTop: 16 }}>{langToggle}</div>
        </div>
      </div>
    );
  }

  const header = (
    <div style={S.bar}>
      <span style={{ fontSize: 22 }}>🔑</span>
      <div>
        <div style={S.barTitle}>{t('title')}</div>
        <div style={S.barSub}>{ctx?.locationName || t('subtitle')}</div>
      </div>
      {langToggle}
    </div>
  );

  if (phase === 'done' || phase === 'already') {
    const already = phase === 'already';
    return (
      <div style={S.page}>
        {header}
        <div style={S.center} data-testid={already ? 'already-screen' : 'done-screen'}>
          <div style={S.bigIcon}>{already ? '🕐' : '✅'}</div>
          <div style={S.doneTitle}>{t(already ? 'alreadyTitle' : 'doneTitle')}</div>
          <p style={{ ...S.note, maxWidth: 420 }}>
            {t(already ? 'alreadyBody' : 'doneBody', { time: timeLabel })}
          </p>
          <p style={{ ...S.note, maxWidth: 420, fontSize: 12.5 }}>{t('privacy')}</p>
          <button
            type="button"
            style={S.ghostBtn}
            data-testid="mark-another"
            onClick={() => { setPhase('idle'); setResNum(''); setLastName(''); setReportedAt(null); setErr(null); }}
          >
            {t('markAnother')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      {header}
      <div style={S.body}>
        <form style={S.card} onSubmit={submit}>
          <p style={{ ...S.note, marginTop: 0 }}>{loadingCtx ? t('loading') : t('intro')}</p>
          <label style={S.label} htmlFor="self-return-res">{t('resLabel')}</label>
          <input
            id="self-return-res"
            style={S.input}
            value={resNum}
            onChange={(e) => setResNum(e.target.value)}
            placeholder={t('resPlaceholder')}
            autoComplete="off"
            autoCapitalize="characters"
            data-testid="res-input"
          />
          <label style={S.label} htmlFor="self-return-name">{t('nameLabel')}</label>
          <input
            id="self-return-name"
            style={S.input}
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder={t('namePlaceholder')}
            autoComplete="family-name"
            data-testid="name-input"
          />
          {err ? (
            <div style={S.err} role="alert" data-testid={err === 'notFound' ? 'not-found-error' : 'submit-error'}>
              {t(err === 'notFound' ? 'notFound' : 'failed')}
            </div>
          ) : null}
          <button
            type="submit"
            style={S.btn(!resNum.trim() || !lastName.trim() || phase === 'sending')}
            disabled={!resNum.trim() || !lastName.trim() || phase === 'sending'}
            data-testid="submit-return"
          >
            {phase === 'sending' ? t('sending') : t('submit')}
          </button>
          <p style={{ ...S.note, fontSize: 12.5 }}>{t('privacy')}</p>
        </form>
      </div>
    </div>
  );
}
