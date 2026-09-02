/**
 * Public T&C signing page — /sign/<token>.
 *
 * Server wrapper only; the flow lives in SignClient.jsx. Split off the client
 * component (gap #11, 2026-08-17) purely so this route can own its metadata:
 * a 'use client' page cannot export any, so every customer who scanned the
 * QR inherited the root layout's `title: 'Ride Fleet'` — the PLATFORM's name
 * in the tab of a contract between the renter and someone else's business.
 *
 * WHY THE TITLE IS NOT GENERATED FROM THE TOKEN HERE:
 * `generateMetadata` would have to fetch /api/sign/:token from the Next
 * server. It cannot reliably: resolveApiBase() (lib/client.js) derives the
 * backend origin from `window.location` and only falls back to
 * NEXT_PUBLIC_API_BASE, which is a browser-facing URL. Worse, a throw in
 * generateMetadata fails the whole route — a new way for a legal signature
 * page to go down, in exchange for a tab title. So this file ships a
 * neutral, unbranded title and SignClient upgrades it to the tenant's name
 * once the payload lands (the page needs JS to render the pads anyway).
 *
 *  - title: the document, not the platform. Never "Ride Fleet".
 *  - noindex/nofollow: the token is the credential and lives in the URL; a
 *    search engine caching one would outlive the link. Same call as the
 *    public shuttle tracker.
 *  - referrer no-referrer: nothing on this page loads a third-party origin,
 *    so unlike /shuttle (which must satisfy the Google Maps key) the token
 *    path can stay completely silent.
 *
 *  - manifest: null. This one line is the reason "Add to Home Screen" no
 *    longer offers to install "Ride Fleet" on the renter's phone. It is the
 *    ONLY inherited identity field that a layout cannot neutralise in
 *    next 14.2 — see the (public)/layout.js comment for the mechanism, and
 *    test/public-route-group.test.jsx, which fails if a public page omits it.
 *
 * The rest of the inherited identity — icons, appleWebApp, description — is
 * not here on purpose: a page that must remember to override each one will
 * eventually forget, so those are neutralised for the whole group in
 * (public)/layout.js.
 */
import { SignClient } from './SignClient';

export const metadata = {
  title: 'Terms & Conditions',
  manifest: null,
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const viewport = {
  themeColor: '#F9FAFB',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function SignPage(props) {
  const params = await props.params;
  return <SignClient token={params.token} />;
}
