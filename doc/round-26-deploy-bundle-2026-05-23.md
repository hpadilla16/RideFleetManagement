# Round 26 deploy bundle — Dejavoo finish + Reports v2 module

**Date:** 2026-05-23 (Saturday evening deploy window)
**Target tag:** `v0.9.0-beta.71`
**Current production:** `v0.9.0-beta.56` (rolled back ~5am Saturday after Round 25 SPIn validation pain — see `round-26-plan-2026-05-23.md` for the full post-mortem)

This doc captures what's being deployed tonight, what changed since the rollback, and the rollback plan if something blows up.

---

## What rolled back last night (the short version)

Round 25 (`v0.9.0-beta.70`) shipped the Sale-driven Dejavoo orchestrator. After four cascading SPIn AutoRental validation hotfixes the terminal finally accepted our Sale request and prompted the customer for their card — but we could not validate end-to-end because:

1. **iPOSpays terminal disclaimer wasn't configured** (no T&C step). Operational task, not code.
2. **Multiple flow scenarios untested** in production (rentalFee=0 prepaid, return CASE B/C, card-on-file CNP, error paths, late returns).
3. **Performance issues** — agreement endpoint returns ~5.7 MB, reservation detail ~8.4 MB, wizard loads take 18+ seconds.
4. **Tactical secondary bugs** (`ReservationCharge.selected` default, SUPER_ADMIN scoping on counter routes, etc.).

The safe move: rollback so IRC agents work normally on Saturday with the legacy flow, regroup, finish properly tonight. Full detail in `doc/round-26-plan-2026-05-23.md`.

---

## What's in tonight's deploy

### A. Dejavoo round 26 work (the punch list from `round-26-plan-2026-05-23.md`)

Driven by the bug inventory in that plan. Phases:

- **Phase 1 (operational, Hector):** iPOSpays disclaimer configured for TPN 816026739983. Disclaimer text drafted (bilingual EN/ES, covers the 4 authorization points required by T&C Sections 11 + 13 — see `round-26-deploy-bundle-2026-05-23.md` for the exact text).
- **Phase 2 (local validation):** scenarios A–I exercised against the SPIN_MOCK or sandbox terminal.
- **Phase 3 (performance):** narrow Prisma `select` clauses on agreement + reservation detail endpoints (Bugs #47 + #48).
- **Phase 4 (pre-existing bugs):** #41 `ReservationCharge.selected` default, #34 counter SUPER_ADMIN scoping, #8 settings nav links.
- **Phase 5 (smoke test):** IRC TEST flag flip → controlled real customer → LIVE flip.

### A.1 Terminal signature → agreement PDF initials (new this evening)

The Dejavoo Sale/Auth response already carries the customer's signature as `SignatureData` (base64 PNG). Before tonight it was being uploaded to Storage and persisted on `ReservationSigning.signatureStoragePath` — but the agreement PDF renderer reads from `Reservation.signatureDataUrl` AND was passing no initials to the T&C renderer, so the four `{{INITIALS_*}}` slots in the printed/emailed contract rendered as blank `___` lines.

Tonight's wiring closes that loop with ~50 lines across 4 files:

- `backend/src/lib/terms/index.js` — `getCanonicalTermsHtml` + `getEffectiveTermsHtmlForTenant` now accept `initials[key] = { html: '...' }` for raw inline HTML in addition to plain strings. String inputs still escape; XSS-safe.
- `backend/src/modules/payment-gateway/counter-orchestrator.service.js` — both the SALE path (rentalFee > 0) and the AUTH-only path (rentalFee = 0) now write `Reservation.signatureDataUrl`, `signatureSignedAt`, and `signatureSignedBy` whenever the Dejavoo response includes a signature. Mirrors the existing customer-portal sign flow so the PDF reads from a single source.
- `backend/src/modules/rental-agreements/rental-agreements.service.js` — builds an `initialsForTerms` object with `{ html: '<img …>' }` for each of `INITIALS_S11_CARD_ON_FILE`, `INITIALS_S11_CNP`, `INITIALS_S11_NO_CHARGEBACK`, `INITIALS_S13_POST_RENTAL` (a compact 22-px-tall img of the captured signature) and passes it to the T&C renderer. `INITIALS_S4_DECLINE` is intentionally left blank — the terminal disclaimer doesn't legally cover the optional-coverage decline decision; that needs to be captured separately in the wizard (TODO).
- `backend/src/lib/terms/index.test.mjs` — three new tests cover the new HTML shape, the existing text-escape behaviour, and the tenant-override path.

All of these touch the Dejavoo / counter / wizard / payments code paths.

### B. Reports v2 module — Rounds 27–31 (everything we built today)

Completely separate code surface area. Lives entirely under:

- `backend/src/modules/reports/*.report.js` (13 new files)
- `backend/src/modules/reports/*.report.test.mjs` (13 new test files)
- `backend/scripts/audit-commissions.mjs` (1 new diagnostic script)
- `frontend/src/app/reports-v2/<slug>/page.js` (13 new pages)
- `frontend/src/components/reports/**` (1 generic ListDrawer + 6 record-type drawers + 6 record-type cards + 6 chart components)

Plus small extensions (backward-compatible) to:

- `backend/src/modules/reports/reports-v2.routes.js` — `registerReport({ subRoutes })` option for drill-downs
- `backend/src/modules/reports/reports-v2.service.js` — 13 registry entries flipped to `AVAILABLE`, titles tightened on `availability` and `commission`, deprecated `url` field removed
- `backend/src/modules/reports/availability-forecast.report.js` — rewritten with Hybrid layout (peak risk, booking pace, LY overlay, sold-out incidence, click-drill side panel, 5-minute cache on the 12-month sold-out scan)
- `backend/src/modules/reports/register-all-reports.js` — 13 new imports
- `frontend/src/components/reports/ReportPageLayout.js` — `extraFilters`, `hideDateRange`, `leftSlot` props (additive)
- `frontend/src/components/reports/DateRangePicker.js` — `BACKWARD_PRESETS` named export
- `frontend/src/components/reports/ReservationDrillDownDrawer.js` — re-export shim for backward compatibility
- `frontend/package.json` — adds `chart.js@^4.4.0` and `react-chartjs-2@^5.2.0`

Final state: **16 of 18 reports AVAILABLE**, 2 deferred on schema work (`damage`, `chargeback`). ~200 backend tests across 14 test files, all passing.

---

## Risk assessment — how do the two halves interact?

**Code surface overlap:** essentially none.

| Concern | Reports v2 touches | Dejavoo work touches | Risk |
|---|---|---|---|
| Counter routes | no | yes | None |
| Wizard state | no | yes | None |
| SPIn client / orchestrator | no | yes | None |
| Agreement / reservation detail endpoints | no (queries `RentalAgreement`, but with own `select`) | yes (narrowing those endpoints' select) | None — separate endpoints |
| Prisma schema | no changes | no changes (round 25's `Tenant.settingsJson` already in) | None |
| Cache infrastructure (`lib/cache.js`) | uses existing API | no changes | None |
| Feature flags | no | yes | None |

**Things to double-check before the build:**

1. **Frontend dependency install** — `chart.js` and `react-chartjs-2` are in `frontend/package.json` but `node_modules` on the droplet won't have them until `npm install` (or `docker compose build --no-cache frontend`). Without this, every `/reports-v2/*` page that imports a chart will throw at runtime.
2. **`docker compose build --no-cache backend worker frontend`** — round 25 retro flagged that Docker's mtime cache lies. `--no-cache` is the safe move when bind-mounted source changes.
3. **`git fetch --tags --force`** on the droplet — round 25 retro flagged that local tags don't update without `--force`.
4. **Smoke check the new routes after deploy** — `GET /api/reports/list` should return 18 entries with the new 13 marked `AVAILABLE`.

---

## Pre-deploy checklist

Backend
- [ ] Run `node --test backend/src/modules/reports/*.test.mjs` in two halves (see roadmap doc — the combined run sometimes hits a 30s wall-clock limit). Each half passes 0 failures.
- [ ] Run the existing payment-gateway tests one more time to verify Round 25's 86+ tests still pass after Round 26's adjustments.
- [ ] Verify `register-all-reports.js` has all 16 imports.
- [ ] Verify `REPORT_REGISTRY` in `reports-v2.service.js` has 16 entries with `status: 'AVAILABLE'` (everything except `damage` and `chargeback`).

Frontend
- [ ] `cd frontend && npm install` (locally) — confirm `chart.js` and `react-chartjs-2` resolve cleanly.
- [ ] `cd frontend && npm run build` — confirm no missing imports on any of the 13 new pages.

Operational (Hector)
- [ ] iPOSpays disclaimer configured for TPN 816026739983 (Bug #43).
- [ ] At least Scenario A (standard checkout) validated against the sandbox terminal.
- [ ] IRC feature flag set to TEST (not LIVE) for the first real-customer pass.

Deploy
- [ ] On droplet: `git fetch --tags --force && git checkout v0.9.0-beta.71`.
- [ ] `docker compose build --no-cache backend worker frontend`.
- [ ] `docker compose up -d`.
- [ ] `docker compose logs -f backend` and watch for "registerReport: <slug>" lines × 16 (or however the startup logs report it). Confirm no exceptions.
- [ ] Hit `https://<droplet>/api/reports/list` — confirm 18 entries, 16 AVAILABLE.

Post-deploy quick smoke
- [ ] Open `/reports-v2/` — confirm 16 tiles are clickable and the 2 deferred ones show "Coming soon".
- [ ] Open one heavy report (`/reports-v2/utilization`) — confirm the chart renders.
- [ ] Open one drill-drawer (`/reports-v2/availability-forecast` → click a heat cell) — confirm the drawer opens and lists reservations.
- [ ] Run `node backend/scripts/audit-commissions.mjs` against production DB (read-only — safe). Paste output back for triage.

---

## Rollback plan

If Dejavoo fails again tonight, rolling back to `v0.9.0-beta.56` loses the Reports v2 module too. That's an acceptable regression because:

- The **legacy `/reports` page is still live and untouched.** All existing reports the team uses today keep working after rollback. Nobody loses functionality, they just lose access to the 13 new reports.
- Reports v2 is **opt-in via the `/reports-v2/` URL**. No nav-bar entry is required for it to work; if you want extra safety, gate the link from the main nav behind a feature flag so users in production don't even see it until you're confident.

If only Dejavoo fails and Reports v2 looks healthy, the cleanest path is to:

1. Roll back to `v0.9.0-beta.56` (restores legacy Dejavoo + drops Reports v2 — the safe move, IRC agents unaffected).
2. Branch + cherry-pick the Reports v2 commits onto `beta.56` as a small reports-only release (`v0.9.0-beta.71-reports-only`).
3. Re-deploy the reports-only release.

Worth scripting that cherry-pick path **before** tonight's deploy if you want a guaranteed non-Dejavoo fallback path — say the word and I'll write the script.

---

## What's new since round 26 plan was written (this morning → tonight)

- 13 new reports built end-to-end (backend + frontend + tests).
- 14 backend test files added; ~200 tests passing across the reports module.
- 5-minute Redis cache layer added to `utilization.computeData` and `availability-forecast.computeSoldOutByMonth`.
- `audit-commissions.mjs` diagnostic script (read-only) added under `backend/scripts/`.
- Reports v2 roadmap doc updated to reflect final state.

The Dejavoo plan from this morning is unchanged — round 26's punch list (Bugs #43–#48 + pre-existing #41, #34, #8) is still the work to land tonight on the payment side.
