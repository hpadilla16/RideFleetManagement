'use client';

/**
 * The screen the subscriber lands on after Authorize.Net takes their card.
 *
 * It POSTs once to /api/public/billing/autopay/:token/return, which does the
 * real work: read what was saved, start the ARB subscription, and write the
 * subscription + ledger rows in one transaction. Every outcome below is a state
 * the backend can return, and each one is worded so the customer knows whether
 * they still have something to do.
 *
 * WHAT MUST NEVER HAPPEN HERE: showing "active" when the ARB subscription did
 * not start. The card would be on file, billing would silently never run, and
 * nobody would notice until someone audited revenue by hand. So
 * `method_saved_not_activated` gets its own honest screen rather than being
 * folded into success.
 *
 * LANGUAGE — English by default, Spanish reachable, sharing the enrollment
 * page's page-local key so a subscriber who switched language before typing
 * their card is still reading the same language when they come back. See
 * ../autopay-lang.js.
 *
 * BILLING DATES: rendered by that module's formatCalendarDate, whose
 * `timeZone: 'UTC'` is LOAD-BEARING and does NOT vary with the language — same
 * comment as the enrollment page. Without it, a reader west of UTC gets the
 * PREVIOUS day and the receipt disagrees with the card.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../../../../../lib/client';
import { LangToggle, formatMoney, useAutopayLang } from '../autopay-lang';

const STRINGS = {
  en: {
    docTitle: 'Autopay confirmation',
    loading: 'Confirming…',
    deadTitle: 'This link is no longer active',
    deadBody: 'We could not confirm the activation from this link. Contact us and we will check the status of your subscription.',
    noMethodTitle: 'No payment method was saved',
    noMethodBody: 'It looks like you left before finishing. You can open the link in your email again to complete the process.',
    notActivatedTitle: 'We saved your payment method',
    notActivatedBody: 'We could not turn on automatic payment right now. Your method is saved securely and our team will finish the activation. We will confirm by email — there is nothing else you need to do.',
    notRepointedTitle: 'We saved your new method',
    notRepointedBody: 'We could not link it to your subscription yet. Our team will finish it and confirm by email — there is nothing else you need to do.',
    inProgressTitle: 'We are activating your autopay',
    inProgressBody: 'We have your payment method and we are finishing the activation. Reload this page in a few seconds.',
    updatedTitle: 'Payment method updated',
    activatedTitle: 'Autopay is active',
    updatedBodyCard: 'Future charges for {company} will be made to the {card}.',
    updatedBodyNoCard: 'Future charges for {company} will be made to the new method.',
    activatedBodyCard: '{company}’s subscription is set up for automatic payment with the {card}.',
    activatedBodyNoCard: '{company}’s subscription is set up for automatic payment.',
    cardWithBrand: '{brand} card ending in {last4}',
    cardNoBrand: 'card ending in {last4}',
    dtNextCharge: 'Next charge',
    dtFirstCharge: 'First charge',
    dtPlan: 'Plan',
    dtAmount: 'Amount',
    dtReference: 'Reference',
    fine: 'We will email you a receipt for every charge. You can cancel autopay by giving us 30 days’ notice.',
  },
  es: {
    docTitle: 'Confirmación de autopago',
    loading: 'Confirmando…',
    deadTitle: 'Este enlace ya no está activo',
    deadBody: 'No pudimos confirmar la activación desde este enlace. Comunícate con nosotros y verificamos el estado de tu suscripción.',
    noMethodTitle: 'No se guardó ningún método',
    noMethodBody: 'Parece que saliste antes de terminar. Puedes volver a abrir el enlace de tu correo para completar el proceso.',
    notActivatedTitle: 'Guardamos tu método de pago',
    notActivatedBody: 'No pudimos activar el cobro automático en este momento. Tu método quedó guardado de forma segura y nuestro equipo completará la activación. Te confirmaremos por correo — no necesitas hacer nada más.',
    notRepointedTitle: 'Guardamos tu método nuevo',
    notRepointedBody: 'No pudimos asociarlo todavía a tu suscripción. Nuestro equipo lo completará y te confirmará por correo — no necesitas hacer nada más.',
    inProgressTitle: 'Estamos activando tu autopago',
    inProgressBody: 'Ya recibimos tu método de pago y estamos terminando la activación. Vuelve a cargar esta página en unos segundos.',
    updatedTitle: 'Método de pago actualizado',
    activatedTitle: 'Autopago activado',
    updatedBodyCard: 'Los próximos cargos de {company} se harán a la {card}.',
    updatedBodyNoCard: 'Los próximos cargos de {company} se harán al método nuevo.',
    activatedBodyCard: 'La suscripción de {company} quedó configurada para cobro automático con la {card}.',
    activatedBodyNoCard: 'La suscripción de {company} quedó configurada para cobro automático.',
    cardWithBrand: 'tarjeta {brand} terminada en {last4}',
    cardNoBrand: 'tarjeta terminada en {last4}',
    dtNextCharge: 'Próximo cargo',
    dtFirstCharge: 'Primer cargo',
    dtPlan: 'Plan',
    dtAmount: 'Monto',
    dtReference: 'Referencia',
    fine: 'Te enviaremos un recibo por cada cargo. Puedes cancelar el autopago avisándonos con 30 días de anticipación.',
  },
};

function cardLabel(t, brand, last4) {
  if (!last4) return null;
  return brand ? t('cardWithBrand', { brand, last4 }) : t('cardNoBrand', { last4 });
}

export function AutopayReturnClient({ token }) {
  const [result, setResult] = useState(null);
  const [dead, setDead] = useState(false);
  const [loading, setLoading] = useState(true);
  const { t, lang, setLang, fmtDate } = useAutopayLang(STRINGS);
  // React 18 StrictMode fires effects twice in development. The backend is
  // idempotent and rate limited, so a second POST is harmless — but there is no
  // reason to send it, and not sending it keeps the dev logs honest.
  const fired = useRef(false);

  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true;
    (async () => {
      try {
        setResult(await api(`/api/public/billing/autopay/${token}/return`, { method: 'POST' }));
      } catch {
        setDead(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // Server metadata can only carry one language and carries the default; the
  // tab follows the reader once their language is resolved. Task only — no
  // company name, no amount: this URL is a credential.
  useEffect(() => {
    document.title = t('docTitle');
  }, [t]);

  if (loading) {
    return <Shell lang={lang} setLang={setLang}><p style={S.p}>{t('loading')}</p></Shell>;
  }

  if (dead) return <Outcome lang={lang} setLang={setLang} title={t('deadTitle')} body={t('deadBody')} />;

  if (result.status === 'no_method') {
    return <Outcome lang={lang} setLang={setLang} title={t('noMethodTitle')} body={t('noMethodBody')} />;
  }

  if (result.status === 'method_saved_not_activated') {
    return <Outcome lang={lang} setLang={setLang} title={t('notActivatedTitle')} body={t('notActivatedBody')} />;
  }

  if (result.status === 'method_saved_not_repointed') {
    return <Outcome lang={lang} setLang={setLang} title={t('notRepointedTitle')} body={t('notRepointedBody')} />;
  }

  if (result.status === 'in_progress') {
    return <Outcome lang={lang} setLang={setLang} title={t('inProgressTitle')} body={t('inProgressBody')} />;
  }

  const updated = result.status === 'updated';
  const card = cardLabel(t, result.cardBrand, result.cardLast4);
  const chargeDate = updated ? result.nextChargeDate : result.firstChargeDate;
  const bodyKey = updated
    ? (card ? 'updatedBodyCard' : 'updatedBodyNoCard')
    : (card ? 'activatedBodyCard' : 'activatedBodyNoCard');

  return (
    <Shell lang={lang} setLang={setLang}>
      <h1 style={S.h1}>{t(updated ? 'updatedTitle' : 'activatedTitle')}</h1>
      <p style={S.p}>{t(bodyKey, { company: result.companyName, card })}</p>
      <dl style={S.dl}>
        {/* "First charge" on an enrollment, "Next charge" on an update. The
            distinction is what stops the "I thought this was free" call, and it
            survives in both languages — see dtFirstCharge / dtNextCharge. */}
        <dt style={S.dt}>{t(updated ? 'dtNextCharge' : 'dtFirstCharge')}</dt>
        <dd style={S.dd}>{fmtDate(chargeDate)}</dd>
        {!updated && result.planName ? (
          <>
            <dt style={S.dt}>{t('dtPlan')}</dt>
            <dd style={S.dd}>{result.planName}</dd>
            <dt style={S.dt}>{t('dtAmount')}</dt>
            <dd style={S.dd}>{`$${formatMoney(result.amount)} ${result.currency}`}</dd>
          </>
        ) : null}
        {/* The Authorize.Net subscription id. Shown because it is the first
            thing support asks for, and useless to anyone without our
            transaction key. */}
        <dt style={S.dt}>{t('dtReference')}</dt>
        <dd style={S.dd}>{result.reference}</dd>
      </dl>
      <p style={S.fine}>{t('fine')}</p>
    </Shell>
  );
}

/** Every non-receipt outcome is the same shape: a heading and one paragraph. */
function Outcome({ title, body, lang, setLang }) {
  return (
    <Shell lang={lang} setLang={setLang}>
      <h1 style={S.h1}>{title}</h1>
      <p style={S.p}>{body}</p>
    </Shell>
  );
}

function Shell({ lang, setLang, children }) {
  return (
    <main style={S.wrap}>
      {/* The toggle sits on every state, dead ends included: a Spanish speaker
          who lands on a failed activation must not be told, in English, to
          contact us. */}
      <div style={S.head}>
        <LangToggle lang={lang} setLang={setLang} />
      </div>
      {children}
    </main>
  );
}

const S = {
  wrap: {
    maxWidth: '32rem',
    margin: '0 auto',
    padding: '3rem 1.5rem',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    color: '#17141F',
  },
  head: { display: 'flex', justifyContent: 'flex-end', marginBottom: '1.5rem' },
  h1: { fontSize: '1.5rem', fontWeight: 600, margin: '0 0 .75rem' },
  p: { fontSize: '1rem', lineHeight: 1.6, color: '#4A4458', margin: '0 0 1.5rem' },
  dl: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '.4rem 1.25rem',
    margin: '0 0 1.5rem',
    fontSize: '.92rem',
  },
  dt: { color: '#6B6478', fontWeight: 600 },
  dd: { margin: 0, fontVariantNumeric: 'tabular-nums' },
  fine: { fontSize: '.82rem', color: '#6B6478', lineHeight: 1.55 },
};
