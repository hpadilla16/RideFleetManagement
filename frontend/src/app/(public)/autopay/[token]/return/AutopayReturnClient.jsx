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
 * WHAT MUST NEVER HAPPEN HERE: showing "activado" when the ARB subscription did
 * not start. The card would be on file, billing would silently never run, and
 * nobody would notice until someone audited revenue by hand. So
 * `method_saved_not_activated` gets its own honest screen rather than being
 * folded into success.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../../../../../lib/client';

function formatDate(iso) {
  // Calendar date, formatted in UTC to match how it was built — see the same
  // comment on the enrollment page. Without timeZone: 'UTC', es-PR renders the
  // PREVIOUS day and the receipt disagrees with the card.
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso || '';
  return new Intl.DateTimeFormat('es-PR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function cardLabel(brand, last4) {
  if (!last4) return null;
  return brand ? `${brand} terminada en ${last4}` : `terminada en ${last4}`;
}

export function AutopayReturnClient({ token }) {
  const [result, setResult] = useState(null);
  const [dead, setDead] = useState(false);
  const [loading, setLoading] = useState(true);
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

  if (loading) return <Shell><p style={S.p}>Confirmando…</p></Shell>;

  if (dead) {
    return (
      <Shell>
        <h1 style={S.h1}>Este enlace ya no está activo</h1>
        <p style={S.p}>
          No pudimos confirmar la activación desde este enlace. Comunícate con nosotros y
          verificamos el estado de tu suscripción.
        </p>
      </Shell>
    );
  }

  if (result.status === 'no_method') {
    return (
      <Shell>
        <h1 style={S.h1}>No se guardó ningún método</h1>
        <p style={S.p}>
          Parece que saliste antes de terminar. Puedes volver a abrir el enlace de tu correo
          para completar el proceso.
        </p>
      </Shell>
    );
  }

  if (result.status === 'method_saved_not_activated') {
    return (
      <Shell>
        <h1 style={S.h1}>Guardamos tu método de pago</h1>
        <p style={S.p}>
          No pudimos activar el cobro automático en este momento. Tu método quedó guardado
          de forma segura y nuestro equipo completará la activación. Te confirmaremos por
          correo — no necesitas hacer nada más.
        </p>
      </Shell>
    );
  }

  if (result.status === 'method_saved_not_repointed') {
    return (
      <Shell>
        <h1 style={S.h1}>Guardamos tu método nuevo</h1>
        <p style={S.p}>
          No pudimos asociarlo todavía a tu suscripción. Nuestro equipo lo completará y te
          confirmará por correo — no necesitas hacer nada más.
        </p>
      </Shell>
    );
  }

  if (result.status === 'in_progress') {
    return (
      <Shell>
        <h1 style={S.h1}>Estamos activando tu autopago</h1>
        <p style={S.p}>
          Ya recibimos tu método de pago y estamos terminando la activación. Vuelve a cargar
          esta página en unos segundos.
        </p>
      </Shell>
    );
  }

  const updated = result.status === 'updated';
  const card = cardLabel(result.cardBrand, result.cardLast4);
  const chargeDate = updated ? result.nextChargeDate : result.firstChargeDate;

  return (
    <Shell>
      <h1 style={S.h1}>{updated ? 'Método de pago actualizado' : 'Autopago activado'}</h1>
      <p style={S.p}>
        {updated
          ? `Los próximos cargos de ${result.companyName} se harán ${card ? `a la tarjeta ${card}` : 'al método nuevo'}.`
          : `La suscripción de ${result.companyName} quedó configurada para cobro automático${card ? ` con la tarjeta ${card}` : ''}.`}
      </p>
      <dl style={S.dl}>
        {/* "Primer cargo" on an enrollment, "Próximo cargo" on an update. The
            distinction is what stops the "I thought this was free" call. */}
        <dt style={S.dt}>{updated ? 'Próximo cargo' : 'Primer cargo'}</dt>
        <dd style={S.dd}>{formatDate(chargeDate)}</dd>
        {!updated && result.planName ? (
          <>
            <dt style={S.dt}>Plan</dt>
            <dd style={S.dd}>{result.planName}</dd>
            <dt style={S.dt}>Monto</dt>
            <dd style={S.dd}>
              {`$${Number(result.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${result.currency}`}
            </dd>
          </>
        ) : null}
        {/* The Authorize.Net subscription id. Shown because it is the first
            thing support asks for, and useless to anyone without our
            transaction key. */}
        <dt style={S.dt}>Referencia</dt>
        <dd style={S.dd}>{result.reference}</dd>
      </dl>
      <p style={S.fine}>
        Te enviaremos un recibo por cada cargo. Puedes cancelar el autopago avisándonos con
        30 días de anticipación.
      </p>
    </Shell>
  );
}

function Shell({ children }) {
  return <main style={S.wrap}>{children}</main>;
}

const S = {
  wrap: {
    maxWidth: '32rem',
    margin: '0 auto',
    padding: '3rem 1.5rem',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    color: '#17141F',
  },
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
