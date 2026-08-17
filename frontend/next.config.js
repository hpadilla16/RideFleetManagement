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

module.exports = {
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
    ];
  },
};
