# Next.js 15 migration — implementation plan

**Date:** 28 August 2026 · **revised after QA review**
**Current:** Next 14.2.35 · React 18.3.1
**Target:** Next **15.5.24** (pinned) · React 19.x

---

## Why now

Next.js 14 stopped receiving security updates on **2025-10-26**. The first Aikido scan reports **21 CVEs** against `next@14.2.35` and flags the runtime as end-of-life. With Vanta engaged for SOC 2 and ISO 27001, an end-of-life web framework is what their continuous monitoring surfaces on day one.

---

## ⚠️ Pin the version. `latest` is not Next 15.

The npm dist-tags for `next`, verified today:

```
latest:    16.3.3
canary:    16.4.0-canary.10
backport:  15.5.24     ← the newest stable 15.x
```

An unpinned `upgrade latest` jumps to **Next 16** — two majors past the target — and none of Next 16's breaking changes have been assessed against this codebase. Every command in this plan pins explicitly.

---

## What we measured

Next 15's breaking changes are concentrated in server-side request handling. This application is almost entirely client-rendered against a separate Express API, so most of them do not apply. Counts below were re-verified during QA.

| Next 15 breaking change | Exposure |
|---|---|
| `params` becomes async | **5 files** — list confirmed complete |
| `searchParams` becomes async | **0** — all 16 consumers use `useSearchParams()` |
| `cookies()` / `headers()` / `draftMode()` async | **0** — `next/headers` never imported |
| `fetch` no longer cached by default | **0 exposure** — no `fetch` call exists in any of the 12 server files, so Next's server fetch-cache never applied |
| GET Route Handlers no longer cached | **2 handlers** — see the latent trap below |
| React 19 removals | **0** of `defaultProps`, `propTypes`, `createFactory`, `ReactDOM.render`, `useFormState`, string refs, legacy context, `react-dom/test-utils`, `findDOMNode`, `forwardRef`, `next/router` |
| Test tooling must support React 19 | **Already satisfied** |
| `middleware.js` / `instrumentation.js` / `.babelrc` | **None exist** |

### The five affected files

Thin server wrappers over a client component, existing so the route can own its `metadata`:

`(public)/autopay/[token]/page.js:59` · `(public)/autopay/[token]/return/page.js:39` · `(public)/sign/[token]/page.js:55` · `driver/[token]/page.js:28` · `shuttle/[token]/page.js:28`

Each becomes `async function Page({ params })` with `const { token } = await params;`.

### Dependencies are clean — with one manifest correction

Only three packages declare a React peer, and all three accept 19: `react-chartjs-2@5.3.1`, `react-i18next@17.0.2`, `@testing-library/react@16.3.2`. `@sentry/browser` declares no peers at all.

**But `package.json` pins `"react-chartjs-2": "^5.2.0"`, and 5.2.0's own peer range excludes React 19.** The lockfile resolves to 5.3.1, which is fine. So: **bump the manifest floor to `^5.3.0`, and do not regenerate `package-lock.json` from scratch.**

---

## Risks, ranked by what would actually hurt

**1. React 19 hydration is stricter — and the test suite cannot help.** `vitest.config.js` runs jsdom component tests that render client-side only. **No test in this repo performs SSR-then-hydrate**, so the 385-test suite is structurally incapable of catching a hydration mismatch. 227 files carry `'use client'`. The only real defence is walking an enumerated route list with the console open — see verification.

**2. `next.config.js` is not just headers, and two of its exports are load-bearing in ways a build cannot check.**

- **`env: { NEXT_PUBLIC_APP_BUILD: currentBuildId() }`** — read at config-eval time from `public/build-id.txt`. `components/StaleBuildWatcher.jsx:22` compares it against `/build-id.txt` to force a reload on stale tabs. This is the fix for the 2026-08-22 outage that stranded phone users on an app shell referencing deleted chunks, with no reload button on a home-screen install. If the bump disturbs `env` inlining, the watchdog silently stops and that outage is re-armed.
- **Six `headers()` blocks**, several with negative-lookahead regex sources — including `frame-ancestors` for `/showcase` (fixed 2026-08-27; **fails silently** from the framing page), `Cache-Control: no-cache, must-revalidate` (the 2026-08-22 fix), `Referrer-Policy: origin` on `/shuttle/*` (deliberately not `no-referrer`, because Google Maps validates referrer-restricted keys against the Referer header), and `Strict-Transport-Security` gated on `NODE_ENV`.
- **`async rewrites()`** — a dev-only `/api/*` proxy gated on `NEXT_DEV_API_PROXY`.

**3. The mobile app is a WebView on production.** `@capacitor/{core,cli,android,ios}@^8.2.0` with `android/`, `ios/` and `mobile-shell/` checked in; `capacitor.config.js` sets `server.url` to the live site. **Any regression ships to installed mobile apps instantly, with no app-store rollback path.**

**4. `manifest.js` and the `manifest: null` convention.** `(public)/layout.js` documents that Next 14.2 re-applies file-based metadata *after* segment merge, which is why every public page must carry `manifest: null` itself. That is an internal ordering detail of a specific Next minor. If 15 changes the merge order, those lines either become redundant or stop working — and the symptom is a renter being offered "Add Ride Fleet to Home Screen" on a contract page for another business. `test/public-route-group.test.jsx` guards the lines' *presence*, not the behaviour, so the suite stays green either way.

**5. Effect-timing regressions in imperative code.** Not dependency conflicts — `@sentry/browser` is framework-agnostic and the Google Maps integration is a hand-rolled script injection (`lib/google-maps-loader.js`), not a React wrapper. The risk is React 19's effect ordering disturbing canvas pads and timer-driven printing.

---

## Execution

**Step 1 — baseline.** Branch off `origin/main` in a fresh worktree. Record:
- `npm test` (expect 385 across 32 files) and `npx next build` (expect 87/87)
- **The emitted response headers per route class** — `curl -sI` against `/showcase`, `/shuttle/x`, `/`, `/.well-known/assetlinks.json`. Header regressions are risk #2 and there is otherwise nothing to diff against.

**Step 2 — dependencies only, pinned.** `next@15.5.24`, `react@19`, `react-dom@19`; bump the `react-chartjs-2` floor to `^5.3.0`. Inspect the lockfile diff; confirm no `--legacy-peer-deps` was needed. Commit. *Splitting this from the source rewrite means an unexpected peer conflict surfaces before a single line of source moves.*

**Step 3 — source rewrite only.** `npx @next/codemod@latest upgrade 15.5.24` — **pinned, not `@canary`, not `latest`**. Review the diff with `next.config.js` and the five wrappers as named review targets. Confirm it did not convert the static `metadata` exports to `generateMetadata`. Commit.

**Step 4 — hand reconciliation.** Apply async-`params` anywhere the codemod skipped.

**Step 5 — build and suite.** `npx next build`, then `npm test`. Any newly failing test is real signal.

**Step 6 — runtime verification.** Below. This is the step that decides whether the migration is sound.

---

## Verification

The suite covers none of this.

| Surface | What to confirm |
|---|---|
| **Response headers** | `curl -sI` the four route classes and **diff against the step-1 baseline**. Zero differences |
| **Showcase embed** | Load `demo.ridefleetmanager.com/es`, scroll to "El producto por dentro" — the tour renders, not a grey box. The header alone is not proof |
| **Stale-build watchdog** | Confirm `NEXT_PUBLIC_APP_BUILD` is still inlined and matches `/build-id.txt` |
| **Hydration** | Walk with the console open: `/`, `/sign/<token>`, `/autopay/<token>`, `/autopay/<token>/return`, `/driver/<token>`, `/shuttle/<token>`, `/book`, `/guest`, `/kiosk`. **Zero hydration errors** |
| **Signature pads — all seven** | `(public)/sign/[token]`, `customer/sign-agreement`, `sign-addendum`, `sign-loaner`, `customer/precheckin`, `checkout/mobile/[token]`, `kiosk`. Include lifting the pen mid-initial |
| **Printing** | Eight `window.print()` sites; two fire from a timer after mount and one writes an inline print script into a spawned window. Timer-after-mount print is exactly what React 19 effect timing disturbs. Test reports, inspection-compare, inspection-report, reservation and vehicle prints |
| **File uploads** | 53 `type="file"` / `FormData` sites — exercise inspection photos and document upload |
| **Shuttle live map** | Maps renders, markers move, zone drawing works. If it degrades to card-only, check `Referrer-Policy` on `/shuttle/*` first |
| **Mobile app** | Open the Capacitor build against the deployed site before announcing done |
| **`manifest: null`** | On a public contract page, confirm no "Add to Home Screen" prompt for the platform |
| **Checkout wizard** | Full check-out including the skip-payment path |

---

## Rollback

`ops/deploy.sh` is blue-green with a health check before the nginx flip. Nothing here touches Prisma, the database, or the backend — confirmed: no `next/headers`, no server-side data access, no server actions. **But rollback is a full rebuild of the previous commit, not a container swap**, because `Dockerfile.prod` bakes `NEXT_PUBLIC_*` at build time. Slower than a flip; still safe.

---

## Latent trap worth recording

The two `.well-known` route handlers (`apple-app-site-association`, `assetlinks.json`) read four env vars at module scope: `RIDEFLEET_APPLE_TEAM_ID`, `RIDEFLEET_IOS_BUNDLE_ID`, `RIDEFLEET_ANDROID_SHA256_CERT_FINGERPRINTS`, `RIDEFLEET_ANDROID_APP_ID`. **None is set in `docker-compose.prod.yml` or `Dockerfile.prod`**, so both read `undefined` and deep linking is already inert in production (`applinks.details: []`, `sha256_cert_fingerprints: []`).

Next 15 makes GET handlers dynamic, moving those reads from build time to request time. Output is identical today. But **after this migration, setting those vars at runtime alone will start changing served output**, where under Next 14 it would have been ignored.

---

## Out of scope

Backend untouched. Transitive CVEs (`undici`, `brace-expansion`, `basic-ftp`, `ip-address`) may resolve as a side effect — confirming that is a separate pass. `nodemailer` is handled in the Aikido remediation task.
