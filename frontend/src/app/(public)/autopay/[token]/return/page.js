/**
 * Autopay return leg — /autopay/<token>/return.
 *
 * Server wrapper only; the work lives in AutopayReturnClient.jsx, same split as
 * the enrollment page and (public)/sign/[token].
 *
 * Authorize.Net sends the subscriber back here after they save the card. It
 * does NOT tell us which payment profile was created, so the backend reads it
 * off the customer profile and only then starts the recurring subscription.
 * That work MUST stay idempotent — a refresh, a double-click, or
 * back-then-forward all land here again, and each one must not create a second
 * ARB subscription, which would bill the customer twice a month with no obvious
 * cause. The idempotency lives on the backend (an atomic invite claim plus a
 * re-read of the subscription's arbSubscriptionId), not in this component.
 *
 *  - manifest: null — the one identity field a layout cannot neutralise in
 *    next 14.2, enforced by test/public-route-group.test.jsx. See
 *    (public)/layout.js for the mechanism.
 */
import { AutopayReturnClient } from './AutopayReturnClient';

export const metadata = {
  title: 'Confirmación de autopago',
  manifest: null,
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const viewport = {
  themeColor: '#FBFAFC',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function AutopayReturnPage({ params }) {
  return <AutopayReturnClient token={params.token} />;
}
