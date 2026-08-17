/**
 * Public shuttle tracker page — /shuttle/<token>.
 *
 * Server wrapper only. The metadata matters as much as the UI:
 *  - referrer `origin`: the token IS the credential and lives in the URL
 *    path, so the path must never ride out in a Referer — but Google Maps
 *    validates referrer-restricted keys against the Referer header, so
 *    total silence (no-referrer) would break the key. `origin` sends only
 *    "https://ridefleetmanager.com/". Keep in sync with next.config.js.
 *  - noindex/nofollow: tokenized links are personal and expiring; a search
 *    engine caching one would outlive the link's own death.
 */
import { ShuttleTrackerClient } from './TrackerClient';

export const metadata = {
  title: 'Shuttle',
  referrer: 'origin',
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
