/**
 * This file did not exist until 2026-08-15 — the app ran on Next defaults.
 * It exists now for HEADERS, at the marketing team's request. Keep it thin.
 */

/**
 * AI-crawler posture, mirrored from the marketing site: this app hosts the
 * public showcase, which is the most copyable thing we serve. noai/noimageai
 * are advisory but the major operators honor them; robots.txt (public/) does
 * the crawler-by-crawler blocking.
 */
const NOAI = { key: 'X-Robots-Tag', value: 'noai, noimageai' };

const fs = require('fs');

/**
 * The identity of THIS bundle, frozen at build time. public/build-id.txt
 * carries the same value but is served by whichever deployment is live now,
 * so a tab whose JavaScript predates the current deploy can tell.
 */
function currentBuildId() {
  try { return fs.readFileSync('public/build-id.txt', 'utf8').trim(); } catch { return 'dev'; }
}

module.exports = {
  env: { NEXT_PUBLIC_APP_BUILD: currentBuildId() },
  /**
   * DEV ONLY: `NEXT_DEV_API_PROXY=https://host npx next dev` makes the dev
   * server proxy /api/* server-side, so a local frontend can talk to a remote
   * backend without CORS (the public endpoints send no CORS headers — in
   * production the page and API share an origin, so none are needed). The env
   * var is never set in the production image; this returns [] there.
   */
  async rewrites() {
    const proxy = process.env.NEXT_DEV_API_PROXY;
    if (!proxy) return [];
    return [{ source: '/api/:path*', destination: `${proxy.replace(/\/$/, '')}/api/:path*` }];
  },
  async headers() {
    return [
      /**
       * THE APP SHELL MUST ALWAYS BE REVALIDATED (outage, 2026-08-22).
       *
       * Next serves prerendered pages with `s-maxage=31536000,
       * stale-while-revalidate` and NO max-age, so browsers fall back to
       * heuristic caching and keep the old HTML — which references JS chunk
       * filenames that no longer exist after a deploy. The app then fails to
       * load data and the agent sees empty screens. On a PC a hard refresh
       * escapes it; on a phone, and especially on the home-screen install
       * where there is no reload button, there is no way out.
       *
       * `no-cache` does not mean "do not cache" — it means revalidate before
       * use. With the ETag already in place that is a cheap 304 and the shell
       * is always current.
       *
       * /_next/static and /_next/image keep their immutable long cache: those
       * filenames carry a content hash, so they can never go stale.
       */
      {
        source: '/:path((?!_next/static|_next/image).*)',
        headers: [{ key: 'Cache-Control', value: 'no-cache, must-revalidate' }],
      },
      {
        // The showcase may be framed ONLY by us and the marketing site.
        // Without this, anyone could iframe our demo into their own page and
        // present the product as theirs (the marketing team's finding —
        // nothing sent frame-ancestors at all). NOTE: Vercel preview deploys
        // (*.vercel.app) are deliberately NOT allowed; the marketing team
        // tests embeds against production or asks us to add an origin.
        source: '/showcase',
        headers: [
          {
            // The two Vercel origins are the marketing site's STABLE aliases
            // (project alias + git-main branch alias, 2026-08-17) so the team
            // can verify the embed before ridefleet.com goes live. Hashed
            // per-deployment/per-PR URLs stay blocked BY DESIGN — never add
            // one, and never the *.vercel.app wildcard (it would let anyone
            // with a Vercel account frame the showcase as their own).
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://ridefleet.com https://www.ridefleet.com https://ridefleet-web.vercel.app https://ridefleet-web-git-main-hpadilla16s-projects.vercel.app",
          },
          NOAI,
        ],
      },
      {
        // The public tracker's token lives in the URL path — it must never
        // ride out in a Referer. `origin` (not no-referrer) because Google
        // Maps validates referrer-restricted API keys against the Referer
        // header: Google sees "https://ridefleetmanager.com/", never the
        // path. Keep in sync with the page's metadata.referrer.
        source: '/shuttle/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'origin' }],
      },
      {
        // Everything else: an ops app has no business being framed anywhere.
        source: '/:path((?!showcase).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          NOAI,
        ],
      },
      {
        // Baseline security headers on every response (TL due diligence,
        // 2026-08-22). These are the safe, no-conflict ones:
        //  - nosniff: stop MIME-type guessing.
        //  - Permissions-Policy: deny features we don't use; camera/geolocation
        //    stay 'self' because the kiosk captures licence photos and the
        //    tracker uses location.
        // Content-Security-Policy is deliberately NOT set here — a real CSP has
        // to be tuned against Google Maps, Sentry and the inline theme-boot
        // script, and shipping a wrong one silently breaks the app. It gets its
        // own change with browser verification.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Permissions-Policy', value: 'geolocation=(self), camera=(self), microphone=()' },
        ],
      },
      {
        // Default Referrer-Policy everywhere EXCEPT /shuttle, which sets its own
        // `origin` above for Google Maps referrer validation. Excluding shuttle
        // here avoids emitting two conflicting Referrer-Policy headers on it.
        source: '/:path((?!shuttle).*)',
        headers: [
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};
