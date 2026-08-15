/**
 * Public shuttle tracker page — /shuttle/<token>.
 *
 * Server wrapper only. The metadata matters as much as the UI:
 *  - referrer no-referrer: the token IS the credential, and it lives in the
 *    URL path — it must never leak to tile servers or any outbound link via
 *    the Referer header.
 *  - noindex/nofollow: tokenized links are personal and expiring; a search
 *    engine caching one would outlive the link's own death.
 */
import { ShuttleTrackerClient } from './TrackerClient';

export const metadata = {
  title: 'Shuttle',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const viewport = {
  themeColor: '#f4f2f7',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function ShuttleTrackerPage({ params }) {
  return <ShuttleTrackerClient token={params.token} />;
}
