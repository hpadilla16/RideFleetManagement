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
 */
import { SignClient } from './SignClient';

export const metadata = {
  title: 'Terms & Conditions',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const viewport = {
  themeColor: '#F9FAFB',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function SignPage({ params }) {
  return <SignClient token={params.token} />;
}
