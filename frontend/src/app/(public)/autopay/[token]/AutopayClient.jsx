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
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../../lib/client';

/**
 * `startDate` is a CALENDAR date, not an instant — Authorize.Net bills on that
 * day in the merchant's own time, and the backend stores it as the string
 * 'YYYY-MM-DD' for exactly that reason.
 *
 * `timeZone: 'UTC'` is LOAD-BEARING and must match how the Date was built.
 * WITHOUT it, es-PR (UTC-4) renders midnight UTC as the PREVIOUS day, and the
 * customer authorises a charge dated one day before the one that actually runs.
 * Do not "simplify" this option away.
 */
function formatDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat('es-PR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

const CADENCE = { months: { 1: 'mensual', 3: 'trimestral', 6: 'semestral', 12: 'anual' }, days: {} };

function cadenceLabel(unit, length) {
  return CADENCE[unit]?.[length] || `cada ${length} ${unit === 'months' ? 'meses' : 'días'}`;
}

export function AutopayClient({ token }) {
  const [invite, setInvite] = useState(null);
  const [dead, setDead] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

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
      // the customer cannot act on, and on this route the URL contains the
      // token. Say the one thing they can actually do.
      setError('No pudimos abrir el formulario seguro. Intenta de nuevo en un momento.');
    }
  }, [token]);

  if (loading) return <Shell><p style={S.p}>Cargando…</p></Shell>;

  if (dead) {
    return (
      <Shell>
        <h1 style={S.h1}>Este enlace ya no está activo</h1>
        <p style={S.p}>
          Los enlaces de pago son personales y expiran. Comunícate con nosotros y te
          enviamos uno nuevo.
        </p>
      </Shell>
    );
  }

  if (invite.alreadyEnrolled) {
    return (
      <Shell>
        <h1 style={S.h1}>El autopago ya está activo</h1>
        <p style={S.p}>
          La suscripción de {invite.companyName} ya tiene un método de pago guardado. Si
          necesitas cambiarlo, comunícate con nosotros y te enviamos un enlace nuevo.
        </p>
      </Shell>
    );
  }

  const amount = Number(invite.amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <Shell>
      <h1 style={S.h1}>
        {isUpdate ? 'Actualizar método de pago' : 'Autorizar cobro automático'}
      </h1>
      <p style={S.lede}>
        {isUpdate
          ? `${invite.companyName}, aquí puedes reemplazar la tarjeta o cuenta con la que se cobra tu suscripción. El plan y el monto no cambian.`
          : `${invite.companyName}, vas a guardar un método de pago para que tu suscripción se renueve sola, sin que tengas que procesar una factura cada ciclo.`}
      </p>

      <section style={S.card} aria-label="Detalles del cobro">
        <Row k="Plan" v={invite.planName} />
        <Row k="Monto" v={`$${amount} ${invite.currency}`} />
        <Row k="Frecuencia" v={cadenceLabel(invite.intervalUnit, invite.intervalLength)} />
        {/* "Primer cargo", never "próximo cargo", on an enrollment: it is what
            stops the "why was I charged, I thought this was free" call. */}
        <Row
          k={isUpdate ? 'Próximo cargo' : 'Primer cargo'}
          v={formatDate(invite.nextChargeDate || invite.startDate)}
          last
        />
      </section>

      <h2 style={S.h2}>Qué va a pasar</h2>
      <ol style={S.list}>
        <li>Te llevamos al formulario seguro de Authorize.Net, nuestro procesador de pagos.</li>
        <li>
          {isUpdate
            ? 'Reemplazas el método guardado ahí, en su sitio.'
            : 'Ingresas tu tarjeta o cuenta bancaria ahí, en su sitio.'}
        </li>
        <li>Vuelves aquí y te confirmamos que quedó {isUpdate ? 'actualizado' : 'activo'}.</li>
      </ol>

      <div style={S.note}>
        <strong style={S.noteTitle}>Tus datos no pasan por nosotros</strong>
        <p style={S.noteBody}>
          El número completo se ingresa y se guarda en los servidores de Authorize.Net.
          Solo recibimos un identificador y los últimos cuatro dígitos — nunca vemos ni
          almacenamos la tarjeta completa.
        </p>
      </div>

      {error ? <p style={S.error} role="alert">{error}</p> : null}

      <button type="button" style={S.btn} onClick={start} disabled={submitting}>
        {submitting
          ? 'Abriendo el formulario seguro…'
          : isUpdate ? 'Continuar y actualizar el método' : 'Continuar al formulario seguro'}
      </button>

      {/* The consent artefact, verbatim as it was frozen when the link was sent.
          Rendered from the server payload rather than restated here, so what the
          customer reads and what we archived can never drift apart. */}
      <p style={S.fine}>{invite.disclosureText}</p>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <main style={S.wrap}>
      <img src="/ride-logo.png" alt="" width={132} style={S.logo} />
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
  logo: { height: 'auto', display: 'block', marginBottom: '2rem' },
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
  fine: { fontSize: '.82rem', color: '#6B6478', marginTop: '1.25rem', lineHeight: 1.55 },
};
