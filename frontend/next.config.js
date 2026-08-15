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
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' https://ridefleet.com https://www.ridefleet.com",
          },
          NOAI,
        ],
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
