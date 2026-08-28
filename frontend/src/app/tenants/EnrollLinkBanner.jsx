'use client';

/**
 * What the operator sees after pressing "Send enroll link" — Phase 7
 * (2026-08-28), when the platform started emailing the link itself.
 *
 * ── WHY THE URL IS STILL ON THE SCREEN ─────────────────────────────────────
 *
 * The obvious move once the email exists is to stop showing the link: it is
 * stored as a sha256 hash precisely so a leaked database dump cannot hand
 * anybody the enrollment flow, and a URL sitting in a browser looks like the
 * same exposure. It is not. Hashing defends against a DUMP; this URL is being
 * shown to the authenticated SUPER_ADMIN who minted it one second ago, and
 * withholding it from him protects nothing.
 *
 * What withholding it WOULD cost is the only way back from a mistyped billing
 * address. That address is typed by hand on the form immediately above. Get one
 * character wrong and the email lands in a mailbox nobody reads, the customer
 * never enrolls, and the link cannot be retrieved by anyone, ever — the row
 * holds a hash. Re-issuing corrects a typo the operator NOTICED. The visible
 * URL is what covers the one he did not.
 *
 * So the banner does three things, in this order of importance:
 *   1. Names the address it actually went to, loudly, so a typo is caught here
 *      rather than a week later when nobody enrolled.
 *   2. Shows the URL, always, as the fallback.
 *   3. Says plainly when the email did NOT go out — because an operator who
 *      believes it did will close this banner and lose the only copy.
 *
 * The old copy ("Enrollment link - copy it now / This is the only time this
 * link is shown... Send it to the billing contact") is no longer true and has
 * gone: instructing someone to send by hand a link that has already been sent
 * is how a customer gets two emails and picks the dead one.
 */

/**
 * Why the send did not happen, in words an operator can act on.
 *
 * Mapped from OUR OWN coarse codes, never from the mail provider's free text —
 * a provider that rejects a message tends to quote the message back, and the
 * message contains the link.
 */
export const EMAIL_FAILURE_REASONS = {
  MAILER_NOT_CONFIGURED: 'no mail provider is configured on this server, so nothing was sent',
  SEND_FAILED: 'the mail provider rejected it or did not answer',
  NO_RECIPIENT: 'the invite carried no billing contact address',
};

export function emailFailureReason(code) {
  return EMAIL_FAILURE_REASONS[code] || 'the send did not complete';
}

/**
 * The one-line status under the page title.
 *
 * It never says "minted" on its own any more. Minting is no longer the whole
 * of what the button does, and an operator who reads "Enrollment link minted"
 * has no way to tell whether anybody received it.
 */
export function enrollLinkMessage(out = {}) {
  const where = out.emailTo ? ` to ${out.emailTo}` : '';
  if (!out.emailed) {
    return `Link created but NOT emailed — ${emailFailureReason(out.emailResult)}. `
      + 'Copy it from the banner and send it yourself.';
  }
  return out.resent
    ? `Previous links revoked. A replacement was emailed${where}.`
    : `Enrollment link emailed${where}.`;
}

/**
 * `billingDate` and `money` are passed in rather than imported so this stays a
 * presentational component and keeps using the page's own UTC-pinned
 * formatters — a locally-formatted 'YYYY-MM-DD' shows the day BEFORE the one
 * Authorize.Net charges.
 */
export function EnrollLinkBanner({ link, onDismiss, billingDate, money }) {
  if (!link) return null;

  const sub = link.subscription || {};
  const emailed = !!link.emailed;
  const to = link.emailTo || null;

  return (
    <div className="app-banner" style={{ marginBottom: 10 }}>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">
          {emailed ? 'Enrollment link - emailed' : 'Enrollment link - NOT emailed'}
        </span>

        {emailed ? (
          <div className="label">
            {/* The address first. It is the thing that can be wrong, and this is
                the only moment anyone will look at it. */}
            Emailed to <strong>{to}</strong>. If that address is wrong, the customer will never
            see it — the link below is your only copy, because the invite is stored hashed and
            cannot be retrieved again. Check the address before you dismiss this.
          </div>
        ) : (
          <div className="error">
            <strong>This link was NOT emailed</strong> — {emailFailureReason(link.emailResult)}
            {to ? <> (intended for <strong>{to}</strong>)</> : null}. The invite itself is fine
            and still works: send the link below by hand. It is stored hashed and cannot be
            retrieved again, so this is the only copy.
          </div>
        )}

        <input readOnly value={link.url} onFocus={(e) => e.target.select()} />

        {/* Resends revoke their predecessors, so an operator looking at a
            customer who says "the link does not work" needs to know a second
            one was sent — the first email is now a dead link in their inbox,
            and the email itself says so. */}
        {link.resent ? (
          <div className="label">
            Earlier links for this tenant were revoked. The email says so, in both languages, so
            the customer knows which one to use.
          </div>
        ) : null}

        <div className="label">
          Expires {billingDate(String(link.expiresAt).slice(0, 10))}
          {' '}| {sub.planName} - {money(sub.amount, sub.currency)}
          {' '}/ {sub.intervalLength === 12 ? 'year' : 'month'}
          {' '}| First charge {billingDate(sub.startDate)}
          {/* trialEndsAt is null for a deferred start. Saying "trial" here when
              there is none would be the same error the customer-facing page is
              careful to avoid. */}
          {sub.trialEndsAt ? ' | Trial until ' + billingDate(sub.trialEndsAt) : ' | No trial'}
          {' '}| ref {link.tokenPrefix}...
        </div>
      </div>
      <div className="inline-actions">
        <button type="button" onClick={onDismiss}>Done</button>
      </div>
    </div>
  );
}
