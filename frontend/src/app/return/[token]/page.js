/**
 * Public QR self-return page — /return/<token> (Hector, 2026-09-02).
 *
 * Server wrapper only, mirroring /driver/<token>:
 *  - referrer `origin`: the per-location QR token IS the page's credential
 *    and lives in the URL path, so the path must never ride out in a Referer.
 *  - noindex/nofollow: the token dies on disable/rotate; a search engine
 *    caching one would outlive the poster.
 */
import { ReturnClient } from './ReturnClient';

export const metadata = {
  title: 'Devolver el carro',
  referrer: 'origin',
  robots: { index: false, follow: false },
};

export const viewport = {
  themeColor: '#f4f2f7',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function SelfReturnPage(props) {
  const params = await props.params;
  return <ReturnClient token={params.token} />;
}
