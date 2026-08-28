/**
 * Public driver-mode page — /driver/<token> (Phase 3, approved mockup
 * Screens 12–15 + 17a).
 *
 * Server wrapper only, mirroring /shuttle/<token>:
 *  - referrer `origin`: the per-shift token IS the credential and lives in
 *    the URL path, so the path must never ride out in a Referer — but Google
 *    Maps validates referrer-restricted keys against the Referer header, so
 *    total silence would break the key. `origin` sends only the host.
 *  - noindex/nofollow: shift links expire end-of-day and die on revoke; a
 *    search engine caching one would outlive the link's own death.
 */
import { DriverClient } from './DriverClient';

export const metadata = {
  title: 'Modo Conductor',
  referrer: 'origin',
  robots: { index: false, follow: false },
};

export const viewport = {
  themeColor: '#f4f2f7',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function DriverModePage({ params }) {
  return <DriverClient token={params.token} />;
}
