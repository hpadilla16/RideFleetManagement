# Kiosk fold harness (measurement only — never ships)

Renders the REAL kiosk screen components (`LookupScreen`, `IdScreen`, `OffersScreen`,
`PaymentScreen`, `SignScreen`, `SelfieScreen`) inside the real `KioskShell`, with the real
`en`/`es` strings and the real in-flow `AssistNotice`, so puppeteer can measure where each
screen's primary CTA lands relative to the fold (`.kio-main`'s visible bottom) on the
tablet viewports the kiosk runs on. Written 2026-09-04 for the short-viewport fix
(`@media (max-height: 860px)` in `kiosk.css`).

Why a harness: the wizard needs a paired device, a reservation and a live session to reach
step 2+, and the QA replica used for PR #108 was hand-written HTML that missed two real
findings (Spanish PAYMENT wrapping into a stacked layout; the live camera preview pushing
"take my photo" below the fold).

## Use

    cd frontend
    scripts/kiosk-fold-harness/install.sh          # copies the route in (gitignored)
    npx next dev -p 3105                           # in another shell
    S=/tmp/fold TAG=after SHOTS=1 node scripts/kiosk-fold-harness/measure-fold.mjs
    TAG=after node scripts/kiosk-fold-harness/camera-on.mjs   # needs reactStrictMode:false, see install.sh
    scripts/kiosk-fold-harness/uninstall.sh

`measure-fold.mjs` prints, per viewport × language × screen × notice state (none / 1-line /
2-line), the CTA rect vs the fold, flags any visible button under 44px and a hidden progress
row, and writes `measure-<TAG>.json` for before/after diffs. Puppeteer comes from
`backend/node_modules` (no frontend dependency added).

`fold-harness.page.js` must live at `src/app/kiosk/fold-harness/page.js` to run — which is
also why it is gitignored: anything with a `page.js` under `src/app/**` is a public route on
the guest-facing kiosk.
