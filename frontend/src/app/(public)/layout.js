/**
 * Route group for the pages a CUSTOMER opens from a tokenized link on their
 * own phone. It changes no URL — `(public)` is a grouping segment — it exists
 * only to stop the root layout's platform identity from reaching these pages.
 *
 * WHAT WAS ACTUALLY LEAKING (gap #11 follow-up, 2026-08-17)
 * ------------------------------------------------------------------
 * /sign/<token> already overrode `title`, so the leak looked closed. It was
 * not: Next merges metadata per FIELD, and `icons`, `manifest` and
 * `appleWebApp` were never overridden, so they kept resolving from
 * app/layout.js:11-25. What the renter at Autos del Valle's counter saw was
 * the RIDE FLEET logo sitting beside the tenant's name in their tab strip,
 * and an "Add to Home Screen" prompt offering to install "Ride Fleet" —
 * app/manifest.js:3 — on the phone of somebody who has never heard of us.
 *
 * Overriding those three fields per page would work until the next public
 * page forgets one. A layout cannot forget, so the neutral identity lives
 * here and every page under it inherits it.
 *
 *  - icons: a plain document glyph in UI grey (public/document-icon.svg, with
 *    a PNG for iOS's apple-touch-icon, which ignores SVG). No wordmark, no
 *    monogram, none of the brand purple. Neutral is the goal, not "ours".
 *  - appleWebApp: null — its `title` is the platform's, and that string is
 *    what iOS offers as the name of an installed shortcut.
 *  - description: null. The root's is a pitch for this SaaS ("Mobile-first
 *    rental, host, guest, employee…"), which is what a messaging app would
 *    quote under the preview of a customer's contract link.
 *  - robots noindex/nofollow: the token is the credential and it lives in the
 *    URL. A search engine that cached one would outlive the link. Pages state
 *    this too; here it is the floor, not the exception.
 *
 * WHERE `manifest` HAS TO LIVE, AND WHY IT IS NOT HERE
 * ------------------------------------------------------------------
 * It belongs here and it cannot go here. app/manifest.js is FILE-BASED
 * metadata, and next 14.2 re-applies file-based metadata AFTER merging each
 * segment's exported object (mergeStaticMetadata at the tail of
 * mergeMetadata, lib/metadata/resolve-metadata.js). A `manifest: null` in a
 * LAYOUT is therefore overwritten again a moment later — verified against a
 * running server, not assumed — while the same line on the leaf PAGE works,
 * because nothing runs after it. So every page under this group carries
 * `manifest: null` itself, and test/public-route-group.test.jsx fails the
 * build if a new one forgets. Do not "tidy" that line up into this file: it
 * silently stops working, and the only symptom is a renter being offered
 * "Ride Fleet" on their home screen.
 *
 * NOT MOVED HERE: /shuttle/<token>, the other public tokenized page, which
 * has the same leak. Its parent segment `/shuttle` is the STAFF queue screen
 * (app/shuttle/page.js, behind AuthGate + AppShell) and must keep the
 * platform identity, so moving the child alone would split one URL segment
 * across a route group — a trap for whoever next adds a /shuttle route. It
 * needs its own change, deliberately.
 */
export const metadata = {
  appleWebApp: null,
  description: null,
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: '/document-icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/document-icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
};

export default function PublicLayout({ children }) {
  return children;
}
