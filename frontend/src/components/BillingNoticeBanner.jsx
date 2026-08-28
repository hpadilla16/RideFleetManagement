'use client';

/**
 * THE DAY-0 NOTICE. Phase 5.
 *
 * The owner's dunning timeline starts here: "Day 0, first decline — a
 * notification appears on the tenant's dashboard telling them to update their
 * payment method to avoid disconnection. Access is unaffected."
 *
 * Everything about this component follows from that one sentence:
 *
 * - IT IS A BANNER, NOT A BLOCK. Day 0 costs them nothing but a warning, so it
 *   sits above the dashboard and the dashboard still works underneath it. The
 *   screen that actually stops them is TenantSuspendedHold, six days later.
 * - IT SAYS HOW LONG THEY HAVE. A warning with no deadline gets deferred
 *   forever; the whole point of a six-day grace window is that they know it is
 *   six days. `daysRemaining` is computed on the server from `pastDueSince`.
 * - IT CARRIES THE REMEDY, NOT JUST THE PROBLEM. One button, and it emails the
 *   link rather than opening a card form — the same single enrollment path
 *   every other surface uses.
 * - IT IS SILENT WHEN THERE IS NOTHING TO SAY. `notice` is null for a healthy
 *   subscription and for a tenant with none, and this renders nothing at all.
 *   A banner slot that is usually empty is the only kind people still read.
 * - IT ONLY SHOWS FOR SOMEONE WHO CAN ACT. `/api/billing/self` is ADMIN-only,
 *   so an AGENT's fetch 403s and the banner never appears. Telling a counter
 *   agent their employer has not paid is neither useful nor their business.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/client';

export function BillingNoticeBanner() {
  const { t } = useTranslation();
  const [notice, setNotice] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState('');
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    api('/api/billing/self')
      .then((out) => { if (alive) setNotice(out?.notice || null); })
      // Silent. A 403 here is the EXPECTED answer for every non-admin, and a
      // dashboard that shows an error because a user is not an admin would be
      // worse than one that shows nothing.
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!notice || hidden) return null;

  const suspended = notice.code === 'BILLING_SUSPENDED';
  const days = notice.daysRemaining;

  const requestLink = async () => {
    setSending(true);
    try {
      const out = await api('/api/billing/self/payment-link', { method: 'POST' });
      setSent(out?.email || '');
    } catch {
      // The button is a convenience; the banner's job is the warning. A failure
      // to mint a link must not replace the deadline with a stack trace.
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      className={suspended ? 'glass card-lg section-card error' : 'glass card-lg section-card'}
      style={{ marginBottom: 16 }}
      role="alert"
      data-testid="billing-notice"
    >
      <div className="row-between" style={{ alignItems: 'start' }}>
        <div>
          <h3 className="section-title">
            {suspended ? t('billingNotice.suspendedTitle') : t('billingNotice.pastDueTitle')}
          </h3>
          <p className="ui-muted">
            {suspended ? t('billingNotice.suspendedBody') : t('billingNotice.pastDueBody')}
          </p>
          {!suspended && typeof days === 'number' ? (
            <p className="label">
              {days === 0
                ? t('billingNotice.pastDueToday')
                : t('billingNotice.pastDueDeadline', { count: days })}
            </p>
          ) : null}
        </div>
        <div className="stack" style={{ alignItems: 'flex-end' }}>
          {sent ? (
            <span className="ui-muted">{t('billingNotice.sent', { email: sent })}</span>
          ) : (
            <button type="button" onClick={requestLink} disabled={sending}>
              {sending ? t('billingNotice.sending') : t('billingNotice.action')}
            </button>
          )}
          {/* Dismissible for THIS render only — never persisted. It comes back
              on the next page load, every day, until they pay. A warning about
              a deadline that a click can silence forever is a warning that gets
              silenced on the day it first appears. */}
          {!suspended ? (
            <button type="button" className="legal-link-inline" onClick={() => setHidden(true)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              {t('billingNotice.dismiss')}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
