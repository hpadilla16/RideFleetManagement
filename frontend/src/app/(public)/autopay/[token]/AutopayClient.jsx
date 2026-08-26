'use client';

/**
 * Autopay enrollment interstitial — runs on the tenant owner's own device.
 *
 * NO auth: the token in the URL is the auth. The backend re-validates it on
 * every call and answers the SAME bare 404 for missing, expired, used and
 * revoked alike, so this component never learns — and never tells — which.
 *
 * Flow:
 *   1. GET  /api/public/billing/autopay/:token  → plan, amount, cadence, first
 *      charge date, and the exact disclosure text they are consenting to.
 *   2. Button → POST .../start, which mints the ~15-minute Authorize.Net
 *      hosted-page token and returns the form target.
 *   3. We POST that token straight to Authorize.Net's origin. The card is typed
 *      THERE. No PAN ever touches this origin, which is what keeps the platform
 *      at PCI SAQ C.
 *
 * THE TOKEN IS MINTED BEHIND THE BUTTON, NOT ON LOAD. Authorize.Net's hosted
 * token lives about fifteen minutes. Minting it while the customer is still
 * reading the disclosure burns that clock on the one page we actually want them
 * to read. The groundwork minted it on render and said in its own comment that
 * it should be moved; this is that advice taken.
 *
 * LANGUAGE — English by default, Spanish reachable, see ./autopay-lang.js for
 * why the choice is page-local rather than the app's i18next instance.
 *
 * BILLING DATES: rendered by that module's formatCalendarDate, whose
 * `timeZone: 'UTC'` is LOAD-BEARING and does NOT vary with the language. These
 * are 'YYYY-MM-DD' calendar strings because Authorize.Net bills on a calendar
 * day; without the option, a reader west of UTC sees the day BEFORE the one
 * that actually charges. The reasoning is written out in full there.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/client';
import {
  LangToggle,
  formatMoney,
  languageName,
  toSupportedLang,
  useAutopayLang,
} from './autopay-lang';

const STRINGS = {
  en: {
    docTitle: 'Payment method',
    loading: 'Loading…',
    deadTitle: 'This link is no longer active',
    deadBody: 'Payment links are personal and they expire. Contact us and we will send you a new one.',
    enrolledTitle: 'Autopay is already active',
    enrolledBody: '{company}’s subscription already has a payment method saved. If you need to change it, contact us and we will send you a new link.',
    titleUpdate: 'Update payment method',
    titleEnroll: 'Authorize automatic payment',
    ledeUpdate: '{company}, here you can replace the card or account your subscription is charged to. The plan and the amount do not change.',
    ledeEnroll: '{company}, you are about to save a payment method so your subscription renews on its own, without you having to process an invoice every cycle.',
    detailsLabel: 'Charge details',
    rowPlan: 'Plan',
    rowAmount: 'Amount',
    rowFrequency: 'Frequency',
    rowNextCharge: 'Next charge',
    rowFirstCharge: 'First charge',
    whatHappens: 'What happens next',
    step1: 'We send you to the secure form at Authorize.Net, our payment processor.',
    step2Update: 'You replace the saved method there, on their site.',
    step2Enroll: 'You enter your card or bank account there, on their site.',
    step3Update: 'You come back here and we confirm it is updated.',
    step3Enroll: 'You come back here and we confirm it is active.',
    noteTitle: 'Your details do not pass through us',
    noteBody: 'The full number is entered and stored on Authorize.Net’s servers. We only receive an identifier and the last four digits — we never see or store the full card.',
    startFailed: 'We could not open the secure form. Try again in a moment.',
    btnBusy: 'Opening the secure form…',
    btnUpdate: 'Continue and update the method',
    btnEnroll: 'Continue to the secure form',
    disclosureNote: 'The authorization below is the record of what you are agreeing to, shown exactly as it was issued, in {language}.',
    // Cadence. `every {n} {unit}` is the fallback for anything the four named
    // intervals do not cover.
    cadenceMonths1: 'monthly',
    cadenceMonths3: 'quarterly',
    cadenceMonths6: 'every 6 months',
    cadenceMonths12: 'yearly',
    cadenceOtherMonths: 'every {n} months',
    cadenceOtherDays: 'every {n} days',
  },
  es: {
    docTitle: 'Método de pago',
    loading: 'Cargando…',
    deadTitle: 'Este enlace ya no está activo',
    deadBody: 'Los enlaces de pago son personales y expiran. Comunícate con nosotros y te enviamos uno nuevo.',
    enrolledTitle: 'El autopago ya está activo',
    enrolledBody: 'La suscripción de {company} ya tiene un método de pago guardado. Si necesitas cambiarlo, comunícate con nosotros y te enviamos un enlace nuevo.',
    titleUpdate: 'Actualizar método de pago',
    titleEnroll: 'Autorizar cobro automático',
    ledeUpdate: '{company}, aquí puedes reemplazar la tarjeta o cuenta con la que se cobra tu suscripción. El plan y el monto no cambian.',
    ledeEnroll: '{company}, vas a guardar un método de pago para que tu suscripción se renueve sola, sin que tengas que procesar una factura cada ciclo.',
    detailsLabel: 'Detalles del cobro',
    rowPlan: 'Plan',
    rowAmount: 'Monto',
    rowFrequency: 'Frecuencia',
    rowNextCharge: 'Próximo cargo',
    rowFirstCharge: 'Primer cargo',
    whatHappens: 'Qué va a pasar',
    step1: 'Te llevamos al formulario seguro de Authorize.Net, nuestro procesador de pagos.',
    step2Update: 'Reemplazas el método guardado ahí, en su sitio.',
    step2Enroll: 'Ingresas tu tarjeta o cuenta bancaria ahí, en su sitio.',
    step3Update: 'Vuelves aquí y te confirmamos que quedó actualizado.',
    step3Enroll: 'Vuelves aquí y te confirmamos que quedó activo.',
    noteTitle: 'Tus datos no pasan por nosotros',
    noteBody: 'El número completo se ingresa y se guarda en los servidores de Authorize.Net. Solo recibimos un identificador y los últimos cuatro dígitos — nunca vemos ni almacenamos la tarjeta completa.',
    startFailed: 'No pudimos abrir el formulario seguro. Intenta de nuevo en un momento.',
    btnBusy: 'Abriendo el formulario seguro…',
    btnUpdate: 'Continuar y actualizar el método',
    btnEnroll: 'Continuar al formulario seguro',
    disclosureNote: 'La autorización que aparece abajo es el registro de lo que estás autorizando, tal como se emitió, en {language}.',
    cadenceMonths1: 'mensual',
    cadenceMonths3: 'trimestral',
    cadenceMonths6: 'semestral',
    cadenceMonths12: 'anual',
    cadenceOtherMonths: 'cada {n} meses',
    cadenceOtherDays: 'cada {n} días',
  },
};

function cadenceLabel(t, unit, length) {
  if (unit === 'months' && [1, 3, 6, 12].includes(Number(length))) {
    return t(`cadenceMonths${Number(length)}`);
  }
  return t(unit === 'months' ? 'cadenceOtherMonths' : 'cadenceOtherDays', { n: length });
}

export function AutopayClient({ token }) {
  const [invite, setInvite] = useState(null);
  const [dead, setDead] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const { t, lang, setLang, fmtDate } = useAutopayLang(STRINGS);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        setInvite(await api(`/api/public/billing/autopay/${token}`, { bypassCache: true }));
      } catch {
        // Every failure mode collapses to the same dead end on purpose. A
        // distinct "expired" screen would tell an enumerator which tokens were
        // ever real, and the customer's next step is identical either way.
        setDead(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // The server-rendered <title> can only carry one language, and it carries the
  // default; once the reader's language is resolved, the tab follows it. No
  // company name, no amount — this route's URL is a credential and the title is
  // the one part of it a screenshot or a shared tab strip leaks by accident.
  useEffect(() => {
    document.title = t('docTitle');
  }, [t]);

  const isUpdate = invite?.mode === 'update';

  const start = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { hostedPageUrl, hostedToken } = await api(
        `/api/public/billing/autopay/${token}/start`,
        { method: 'POST' },
      );
      // A real cross-origin form POST, not a fetch: Authorize.Net's hosted page
      // takes the browser, and taking the browser is the whole point — the card
      // is typed on their origin, never ours.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = hostedPageUrl;
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'token';
      field.value = hostedToken;
      form.appendChild(field);
      document.body.appendChild(form);
      form.submit();
    } catch {
      setSubmitting(false);
      // Never surface the server's text here: it can carry a gateway error code
      // the customer cannot act on, it is written in one fixed language, and on
      // this route the URL contains the token. Say the one thing they can
      // actually do, in the language they are reading.
      setError(t('startFailed'));
    }
  }, [token, t]);

  if (loading) {
    return <Shell lang={lang} setLang={setLang}><p style={S.p}>{t('loading')}</p></Shell>;
  }

  if (dead) {
    return (
      <Shell lang={lang} setLang={setLang}>
        <h1 style={S.h1}>{t('deadTitle')}</h1>
        <p style={S.p}>{t('deadBody')}</p>
      </Shell>
    );
  }

  if (invite.alreadyEnrolled) {
    return (
      <Shell lang={lang} setLang={setLang}>
        <h1 style={S.h1}>{t('enrolledTitle')}</h1>
        <p style={S.p}>{t('enrolledBody', { company: invite.companyName })}</p>
      </Shell>
    );
  }

  const amount = formatMoney(invite.amount);

  /**
   * THE CONSENT ARCHIVE AND THE LANGUAGE TOGGLE.
   *
   * `disclosureText` is the consent artefact: frozen when the link was sent,
   * hashed, and copied onto the subscription at activation (schema.prisma,
   * TenantSubscription.authorizedDisclosureText). It is rendered from the
   * server payload rather than restated here so that what the customer READS
   * and what we ARCHIVED can never drift apart — and that invariant is exactly
   * why the toggle must NOT translate it in the browser. A client-side
   * translation would put text on screen that no stored record matches, which
   * defeats the point of archiving it.
   *
   * The backend builds that string in one fixed language today
   * (billing.service.js buildDisclosureText — Spanish). So when the reader's
   * language differs from the disclosure's, say so plainly instead of leaving
   * an unexplained foreign-language paragraph under the button.
   *
   * `disclosureLang` is read from the payload and only DEFAULTS to Spanish.
   * The day the backend issues the disclosure in the subscriber's language and
   * sends the tag alongside it, this note disappears on its own and the
   * archived record matches what was on screen with no further change here.
   */
  const disclosureLang = toSupportedLang(invite.disclosureLang) || 'es';

  return (
    <Shell lang={lang} setLang={setLang}>
      <h1 style={S.h1}>{t(isUpdate ? 'titleUpdate' : 'titleEnroll')}</h1>
      <p style={S.lede}>
        {t(isUpdate ? 'ledeUpdate' : 'ledeEnroll', { company: invite.companyName })}
      </p>

      <section style={S.card} aria-label={t('detailsLabel')}>
        <Row k={t('rowPlan')} v={invite.planName} />
        <Row k={t('rowAmount')} v={`$${amount} ${invite.currency}`} />
        <Row k={t('rowFrequency')} v={cadenceLabel(t, invite.intervalUnit, invite.intervalLength)} />
        {/* "First charge", never "next charge", on an enrollment: it is what
            stops the "why was I charged, I thought this was free" call. Both
            languages keep the distinction — see rowFirstCharge / rowNextCharge. */}
        <Row
          k={t(isUpdate ? 'rowNextCharge' : 'rowFirstCharge')}
          v={fmtDate(invite.nextChargeDate || invite.startDate)}
          last
        />
      </section>

      <h2 style={S.h2}>{t('whatHappens')}</h2>
      <ol style={S.list}>
        <li>{t('step1')}</li>
        <li>{t(isUpdate ? 'step2Update' : 'step2Enroll')}</li>
        <li>{t(isUpdate ? 'step3Update' : 'step3Enroll')}</li>
      </ol>

      <div style={S.note}>
        <strong style={S.noteTitle}>{t('noteTitle')}</strong>
        <p style={S.noteBody}>{t('noteBody')}</p>
      </div>

      {error ? <p style={S.error} role="alert">{error}</p> : null}

      <button type="button" style={S.btn} onClick={start} disabled={submitting}>
        {submitting
          ? t('btnBusy')
          : t(isUpdate ? 'btnUpdate' : 'btnEnroll')}
      </button>

      {disclosureLang !== lang ? (
        <p style={S.disclosureNote}>
          {t('disclosureNote', { language: languageName(disclosureLang, lang) })}
        </p>
      ) : null}
      {/* Verbatim, as it was frozen when the link was sent. */}
      <p
        style={disclosureLang !== lang ? { ...S.fine, marginTop: 0 } : S.fine}
        lang={disclosureLang}
      >
        {invite.disclosureText}
      </p>
    </Shell>
  );
}

function Shell({ lang, setLang, children }) {
  return (
    <main style={S.wrap}>
      <div style={S.head}>
        <img src="/ride-logo.png" alt="" width={132} style={S.logo} />
        <LangToggle lang={lang} setLang={setLang} />
      </div>
      {children}
    </main>
  );
}

function Row({ k, v, last }) {
  return (
    <div style={{ ...S.row, ...(last ? S.rowLast : null) }}>
      <span style={S.rowK}>{k}</span>
      <span style={S.rowV}>{v}</span>
    </div>
  );
}

const S = {
  wrap: {
    maxWidth: '34rem',
    margin: '0 auto',
    padding: '2.5rem 1.5rem 4rem',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    color: '#17141F',
    lineHeight: 1.6,
  },
  head: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '1rem',
    marginBottom: '2rem',
  },
  logo: { height: 'auto', display: 'block' },
  h1: { fontSize: '1.6rem', fontWeight: 700, margin: '0 0 .6rem', letterSpacing: '-.01em' },
  h2: { fontSize: '1rem', fontWeight: 700, margin: '2rem 0 .6rem' },
  lede: { fontSize: '1rem', color: '#4A4458', margin: '0 0 1.75rem' },
  p: { fontSize: '1rem', color: '#4A4458', margin: '0 0 1.5rem' },
  card: {
    border: '1px solid #E6E2EC',
    borderRadius: '12px',
    background: '#FBFAFC',
    padding: '.35rem 1.1rem',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '1rem',
    padding: '.7rem 0',
    borderBottom: '1px solid #EDE9F4',
    fontSize: '.94rem',
  },
  rowLast: { borderBottom: 'none' },
  rowK: { color: '#6B6478' },
  rowV: { fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  list: { margin: 0, paddingLeft: '1.2rem', color: '#4A4458', fontSize: '.95rem' },
  note: {
    marginTop: '1.75rem',
    borderLeft: '3px solid #8752FE',
    background: '#F5F1FE',
    borderRadius: '0 8px 8px 0',
    padding: '.9rem 1.1rem',
  },
  noteTitle: { display: 'block', fontSize: '.9rem', marginBottom: '.3rem' },
  noteBody: { margin: 0, fontSize: '.88rem', color: '#4A4458' },
  error: { marginTop: '1.5rem', color: '#B3261E', fontSize: '.9rem' },
  btn: {
    display: 'block',
    width: '100%',
    minHeight: '3rem',
    marginTop: '2rem',
    padding: '.85rem 1.5rem',
    borderRadius: '999px',
    border: 0,
    background: '#8752FE',
    color: '#fff',
    fontSize: '1rem',
    fontWeight: 600,
    cursor: 'pointer',
  },
  disclosureNote: {
    fontSize: '.8rem',
    color: '#6B6478',
    marginTop: '1.25rem',
    marginBottom: '.4rem',
    lineHeight: 1.55,
    fontStyle: 'italic',
  },
  fine: { fontSize: '.82rem', color: '#6B6478', marginTop: '1.25rem', lineHeight: 1.55 },
};
