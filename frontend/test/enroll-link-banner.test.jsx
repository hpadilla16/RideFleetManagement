/**
 * The banner after "Send enroll link" — Phase 7 (2026-08-28).
 *
 * Pinned here, in order of cost-of-being-wrong:
 *
 *  1. THE URL IS ALWAYS ON THE SCREEN. It is the only way back from a mistyped
 *     billing address: the invite stores a sha256, so a link emailed into a
 *     void is a link nobody can ever retrieve. Now that the platform emails it,
 *     "we don't need to show it any more" is the obvious and wrong next edit.
 *  2. A FAILED SEND SAYS SO, LOUDLY. An operator who believes the email went
 *     out will dismiss this banner, and the link goes with it.
 *  3. THE OLD INSTRUCTION IS GONE. "Copy it now / send it to the billing
 *     contact" is no longer the whole truth once the platform has already sent
 *     it, and following it produces a second email and a confused customer.
 *  4. Billing dates render through the page's UTC-pinned formatter.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { EnrollLinkBanner, enrollLinkMessage, emailFailureReason } =
  await import('../src/app/tenants/EnrollLinkBanner');

const URL_ = 'https://app.test/autopay/tok_abcdefghijklmnop';

function link(over = {}) {
  return {
    url: URL_,
    tokenPrefix: 'tok_abcd',
    expiresAt: '2026-09-11T14:00:00.000Z',
    resent: false,
    emailed: true,
    emailTo: 'owner@autosdelvalle.test',
    emailResult: 'SENT',
    subscription: {
      planName: 'Pro',
      amount: '1650',
      currency: 'USD',
      intervalUnit: 'months',
      intervalLength: 1,
      startDate: '2026-09-01',
      trialEndsAt: null,
    },
    ...over,
  };
}

/** The page's own formatters, pinned to UTC exactly as page.js pins them. */
const billingDate = (v) => {
  const [y, m, d] = String(v || '').split('-').map(Number);
  if (!y || !m || !d) return String(v || '');
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
};
const money = (a, c = 'USD') => `$${Number(a).toFixed(2)} ${c}`;

function draw(over = {}, onDismiss = () => {}) {
  return render(
    <EnrollLinkBanner link={link(over)} onDismiss={onDismiss} billingDate={billingDate} money={money} />,
  );
}

describe('the enrollment link banner', () => {
  it('shows the URL even on the happy path — it is the recovery path, not a leak', () => {
    draw();
    const field = screen.getByDisplayValue(URL_);
    expect(field).toBeTruthy();
    expect(field.readOnly).toBe(true);
  });

  it('names the address it actually went to, so a typo is caught here', () => {
    draw();
    expect(screen.getByText('owner@autosdelvalle.test')).toBeTruthy();
    expect(document.body.textContent).toMatch(/Emailed to/);
  });

  it('a failed send is stated plainly, with a reason and the link still shown', () => {
    draw({ emailed: false, emailResult: 'SEND_FAILED' });
    expect(document.body.textContent).toMatch(/NOT emailed/);
    expect(document.body.textContent).toMatch(/rejected it or did not answer/);
    // The invite is fine — saying otherwise would send someone re-minting a
    // perfectly good link and revoking the one they are holding.
    expect(document.body.textContent).toMatch(/still works/);
    expect(screen.getByDisplayValue(URL_)).toBeTruthy();
  });

  it('an unconfigured mailer reads as configuration, not as a customer problem', () => {
    draw({ emailed: false, emailResult: 'MAILER_NOT_CONFIGURED' });
    expect(document.body.textContent).toMatch(/no mail provider is configured/);
  });

  it('an unknown failure code still produces a sentence, never "undefined"', () => {
    draw({ emailed: false, emailResult: 'SOMETHING_NEW' });
    expect(document.body.textContent).toMatch(/the send did not complete/);
    expect(document.body.textContent).not.toMatch(/undefined/);
  });

  it('no longer tells the operator to copy the link and send it himself', () => {
    // The Phase 3 copy. Following it after the platform has already sent the
    // email gives the customer two emails, one of which is a dead link.
    draw();
    const text = document.body.textContent;
    expect(text).not.toMatch(/copy it now/i);
    expect(text).not.toMatch(/Send it to the billing contact/i);
    expect(text).not.toMatch(/only time this link is shown/i);
  });

  it('still warns that the link cannot be retrieved again — that part IS still true', () => {
    draw();
    expect(document.body.textContent).toMatch(/stored hashed and\s+cannot be retrieved again/);
  });

  it('a resend says the earlier links were revoked', () => {
    draw({ resent: true });
    expect(document.body.textContent).toMatch(/Earlier links for this tenant were revoked/);
  });

  it('a first send does not claim to have revoked anything', () => {
    draw();
    expect(document.body.textContent).not.toMatch(/were revoked/);
  });

  it('renders billing dates in UTC — a local render shows the day before the charge', () => {
    draw();
    expect(document.body.textContent).toMatch(/Sep 1, 2026/);
    expect(document.body.textContent).toMatch(/Sep 11, 2026/);
    expect(document.body.textContent).not.toMatch(/Aug 31/);
  });

  it('says "No trial" for a deferred start rather than inventing one', () => {
    draw();
    expect(document.body.textContent).toMatch(/No trial/);
    draw({ subscription: { ...link().subscription, trialEndsAt: '2026-09-15' } });
    expect(document.body.textContent).toMatch(/Trial until/);
  });

  it('renders nothing at all when there is no link', () => {
    const { container } = render(
      <EnrollLinkBanner link={null} onDismiss={() => {}} billingDate={billingDate} money={money} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('Done dismisses', () => {
    const onDismiss = vi.fn();
    draw({}, onDismiss);
    fireEvent.click(screen.getByText('Done'));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('the one-line status message', () => {
  it('never says only "minted" — that leaves delivery unanswered', () => {
    const sent = enrollLinkMessage({ emailed: true, emailTo: 'a@b.test' });
    expect(sent).toMatch(/emailed to a@b\.test/);
    expect(sent).not.toMatch(/^Enrollment link minted\.$/);
  });

  it('a resend reports both the revocation and the delivery', () => {
    const msg = enrollLinkMessage({ emailed: true, resent: true, emailTo: 'a@b.test' });
    expect(msg).toMatch(/Previous links revoked/);
    expect(msg).toMatch(/emailed to a@b\.test/);
  });

  it('a failure tells the operator what to do instead', () => {
    const msg = enrollLinkMessage({ emailed: false, emailResult: 'SEND_FAILED' });
    expect(msg).toMatch(/NOT emailed/);
    expect(msg).toMatch(/send it yourself/);
  });

  it('the failure vocabulary is ours, never a provider error string', () => {
    // A mail provider that rejects a message quotes the message back, and the
    // message contains the link.
    for (const code of ['MAILER_NOT_CONFIGURED', 'SEND_FAILED', 'NO_RECIPIENT']) {
      expect(emailFailureReason(code)).toBeTruthy();
      expect(emailFailureReason(code)).not.toMatch(/http/);
    }
  });
});
