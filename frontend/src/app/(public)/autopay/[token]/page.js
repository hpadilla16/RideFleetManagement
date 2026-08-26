/**
 * Autopay enrollment — /autopay/<token>.
 *
 * Server wrapper only; the flow lives in AutopayClient.jsx, following the
 * (public)/sign/[token] → SignClient split.
 *
 * WHY THIS IS NOT A SERVER COMPONENT DOING THE WORK
 * ------------------------------------------------------------------
 * The proven groundwork made THREE blocking Authorize.Net calls inside a
 * server render. An Authorize.Net latency spike therefore rendered a 500 to a
 * customer who was trying to give us money, with no retry and no spinner. It
 * also could not reach a database at all — the Next app has no Prisma client —
 * which is why its invite store was an in-memory Map. Both problems dissolve
 * when the page becomes a client component talking to the backend, so that is
 * what this is. Same reasoning the sign page already documents: a throw in a
 * server component fails the whole route.
 *
 * WHY THIS PAGE EXISTS AT ALL, RATHER THAN AN INSTANT REDIRECT
 * ------------------------------------------------------------------
 * Authorize.Net's hosted form cannot be branded beyond a few colours — no logo,
 * no custom copy. It just asks for a card with no explanation of who is asking
 * or what will be charged. This page is the only surface we control, so it
 * carries the identity and the disclosure: who we are, the exact amount, the
 * cadence, and the first charge date, shown BEFORE any card is typed. Informed
 * consent up front is also the cheapest dispute insurance there is.
 *
 *  - title: neutral, the task and not the platform.
 *  - noindex/nofollow: the token in the URL IS the credential; a search engine
 *    that cached this page would outlive the link.
 *  - referrer no-referrer: the page loads nothing third-party, so the token
 *    path can stay completely silent.
 *
 *  - manifest: null. The ONE inherited identity field a layout cannot
 *    neutralise in next 14.2 — see the (public)/layout.js comment for the
 *    mechanism, and test/public-route-group.test.jsx, which fails the build if
 *    a public page omits it. Without this line, a tenant's owner is offered our
 *    app on their home screen from a payment page.
 */
import { AutopayClient } from './AutopayClient';

export const metadata = {
  title: 'Método de pago',
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

export default function AutopayEnrollPage({ params }) {
  return <AutopayClient token={params.token} />;
}
