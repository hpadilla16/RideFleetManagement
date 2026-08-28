'use client';

/**
 * The hold screen — what a locked-out staff member sees. Phase 5.
 *
 * A FULL-SCREEN REPLACEMENT, no nav and no shell, exactly like the forced
 * password-change screen it sits beside in AuthGate. Nothing else is on the
 * page because nothing else works, and a disabled sidebar full of things that
 * 403 is worse than no sidebar at all.
 *
 * WHAT IT IS CAREFUL ABOUT
 * ---------------------------------------------------------------------------
 * 1. IT DISTINGUISHES "you owe us" FROM "you are switched off". A tenant
 *    suspended by hand for a compliance hold or an offboarding must NOT be told
 *    to go pay an invoice — the remedy would be wrong and the message
 *    insulting. `billingSuspendedAt` is what separates the two, and it comes
 *    from the session, so the screen can tell them apart before any fetch.
 * 2. IT DEGRADES. `/api/billing/self` is ADMIN-only, so an AGENT sees the hold
 *    screen with no amount, no card and no button — which is correct: they
 *    cannot fix this and should be told to find whoever can, not handed a dead
 *    control.
 * 3. IT NEVER SHOWS A CARD FORM. The button EMAILS a link to the billing
 *    address on the subscription. A suspended session never becomes a
 *    card-entry context; that is the whole reason the endpoint emails.
 * 4. THE WAY OUT IS ALWAYS VISIBLE. Sign out works, because trapping somebody
 *    in a session they cannot leave turns a billing problem into a support call
 *    about a broken app.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/client';

function formatDate(value) {
  if (!value) return null;
  try {
    // UTC, like every other billing date in this app. A date rendered locally
    // shows the day BEFORE the one Authorize.Net acted on.
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

export function TenantSuspendedHold({ me, logout }) {
  const { t } = useTranslation();
  const [billing, setBilling] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');
  const [error, setError] = useState('');

  // Billing was the reason only if billing set it. Read from the session, so
  // the right copy renders on the first paint rather than after a round trip.
  const forNonPayment = !!me?.tenantBillingSuspendedAt;

  useEffect(() => {
    if (!forNonPayment) return;
    // Allowlisted while suspended. A failure here is EXPECTED for a non-admin
    // and must stay silent: the hold screen without the numbers is still a
    // correct hold screen.
    api('/api/billing/self')
      .then((out) => setBilling(out))
      .catch(() => {});
  }, [forNonPayment]);

  const requestLink = async () => {
    setSending(true);
    setError('');
    try {
      const out = await api('/api/billing/self/payment-link', { method: 'POST' });
      setSent(out?.email || '');
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  const sub = billing?.subscription || null;
  const since = formatDate(me?.tenantBillingSuspendedAt || billing?.tenant?.billingSuspendedAt);
  const canPay = !!sub;

  return (
    <main className="auth-wrap auth-animated-split">
      <div className="auth-purple-half" aria-hidden />
      <img src="/ride-logo.png" alt="Ride logo" className="intro-logo" />

      <div className="glass card-lg login-card centered-login login-float-in" role="alert">
        <h1>{forNonPayment ? t('tenantSuspended.title') : t('tenantSuspended.titleGeneric')}</h1>

        <p className="label">
          {forNonPayment ? t('tenantSuspended.body') : t('tenantSuspended.bodyGeneric')}
        </p>

        {since ? (
          <p className="label">{t('tenantSuspended.since', { date: since })}</p>
        ) : null}

        {sub ? (
          <div className="surface-note" style={{ marginTop: 12 }}>
            <p>
              <strong>{sub.planName}</strong>
              {sub.amountFormatted ? ` — $${sub.amountFormatted} ${sub.currency || 'USD'}` : ''}
            </p>
            {sub.cardLast4 ? (
              <p className="label">
                {t('tenantSuspended.cardOnFile', {
                  brand: sub.cardBrand || t('tenantSuspended.card'),
                  last4: sub.cardLast4,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* THE ONE THING THAT STILL WORKS AND CHANGES ANYTHING. It emails; it
            never opens a card form inside a suspended session. */}
        {forNonPayment && canPay ? (
          sent ? (
            <p className="ui-muted" style={{ marginTop: 16 }}>
              {t('tenantSuspended.linkSent', { email: sent })}
            </p>
          ) : (
            <button type="button" style={{ marginTop: 16 }} onClick={requestLink} disabled={sending}>
              {sending ? t('tenantSuspended.sending') : t('tenantSuspended.sendLink')}
            </button>
          )
        ) : null}

        {error ? <p className="error" style={{ marginTop: 12 }}>{error}</p> : null}

        <p className="label" style={{ marginTop: 16 }}>{t('tenantSuspended.contact')}</p>

        <div className="auth-legal-row">
          <button
            type="button"
            className="legal-link-inline"
            onClick={logout}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            {t('tenantSuspended.signOut')}
          </button>
        </div>
      </div>
    </main>
  );
}
