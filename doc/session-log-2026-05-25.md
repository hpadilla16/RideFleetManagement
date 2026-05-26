# Session log — 2026-05-25 (TL Integration ship + Reports v2 ship)

**Day shape:** woke up with `v0.9.0-beta.56` stable, Dejavoo + Reports v2 parked
from Sat night's rollback. Spent the day shipping TL International end-to-end,
cherry-picking Reports v2 onto `beta.56` to ship independently of the still-
parked Dejavoo work, plus a Pre-Paid Reservations Report + check-in bug fixes
+ a long tail of UX cleanup on the franchise imports tray.

**Final production tag:** `v0.9.0-beta.56-tl-reports-v5` (after deploy).
**Branch:** `proxy-on-beta56` (off `v0.9.0-beta.56`).
**Stable Dejavoo bundle waiting on support:** `v0.9.0-beta.72` (still on
`origin/main`, contains deposit double-charge + RentalClassId 2201 fixes).

---

## What shipped today

### Infrastructure — residential proxy for TL International

CloudFlare on TL admin binds the session cookie to the IP that obtained it.
Droplet sits in NYC; Hector's cookies are from his residential PR IP. Direct
fetches from the droplet were 302'd to login.php no matter how fresh the
cookie. **Mitigation:** route TL traffic through a proxy that egresses from
the same residential IP.

Setup:

- **Tailscale** installed on Hector's PC Windows + on the droplet, both on the
  same tailnet
- **Node.js HTTP proxy** (`C:\TLProxy\proxy.js`, ~50 lines, handles HTTP +
  CONNECT for HTTPS) listening on `0.0.0.0:8888` with an allowlist for
  Tailscale CIDR (100.64.0.0/10)
- **Windows Task Scheduler** task `TLProxy` auto-starts the proxy at boot
  (runs as current user)
- **Tailscale IP:** `100.120.215.18` (Hector's PC)
- **Residential egress IP:** `70.125.52.151` (his home internet)
- **Env on droplet:** `TL_INTERNATIONAL_PROXY_URL=http://100.120.215.18:8888`

Code:

- New exported `getTLBrowser` in `backend/src/lib/puppeteer-browser.js` — a
  TL-dedicated browser manager separate from the global PDF/scraper singleton.
  Launches Chromium with `--proxy-server=$TL_INTERNATIONAL_PROXY_URL`.
- `tl-international.service.js`: imports `getTLBrowser` (was `getBrowser`) and
  wraps `globalThis.fetch` calls with `undici` `ProxyAgent` when env is set.

### TL Integration end-to-end

- Cookie/auth: TL **removed CloudFlare** between when our code was written
  (2026-05-20) and the smoke test. Auth is now a single `OTA_SESSION` cookie
  via direct Apache. No more `__cf_logged_in` / `CF_VERIFIED_DEVICE_*` to deal
  with. Cookie expires every 25 min (`Max-Age=1500`); rotate manually.
- **Schema fix:** added `rejectedReason` (TEXT) + `rejectedAt` (TIMESTAMPTZ) to
  `ExternalReservation` via Supabase SQL — Prisma migration drift, the columns
  existed in `schema.prisma` but the table didn't have them.
- **promotionStatus enum drift:** column was TEXT in DB but `schema.prisma`
  declared it as the `ExternalPromotionStatus` enum. Prisma queries with `{ in:
  [...] }` filters generated SQL that Postgres couldn't satisfy (text-to-enum
  operator missing). Converted in place with
  `ALTER TABLE … ALTER COLUMN "promotionStatus" TYPE "ExternalPromotionStatus" USING …::"ExternalPromotionStatus"`
  plus drop-default / re-default-as-enum dance.
- **Sync result (first real run):** 90 pickups fetched in 8m13s. Distribution:
  20 May 2026, 54 June, 6 July, 2 Aug, 1 Dec, 8 Jan-2027.
- **Auto-create customer:** new helper `maybeCreateCustomerFromTl` in
  `tl-international.worker.js`. When promotion-matcher returns
  `customer_not_found` AND `TL_AUTO_CREATE_CUSTOMERS=true`, the worker creates
  a lightweight Customer (firstName + lastName + email + phone, phone falls
  back to `0000000000` placeholder) and re-evaluates — usually flips to AUTO
  so the booking auto-promotes.
- **Status semantics:** new TL bookings promote to Reservation with
  `status: 'CONFIRMED'` (was `'PENDING_FRANCHISE_IMPORT'`). The blue badge
  in the UI is what distinguishes them visually now.

### Reports v2 — cherry-picked from main

Brought all 16 reports + 17 frontend pages + drawers + charts + cards + the
v2 routes + service + register-all + reports-export + chart.js/react-chartjs-2
deps. **Did NOT bring** anything Dejavoo-related — counter-orchestrator,
spin-client, signature wiring all stay on `origin/main` waiting for
re-deploy.

Critical wiring fix discovered at the end: `main.js` was NOT importing
`register-all-reports.js` nor mounting `reportsV2Router`. Cherry-pick brought
the files but the mount was missing. Added:

```js
import { reportsV2Router } from './modules/reports/reports-v2.routes.js';
import './modules/reports/register-all-reports.js';

app.use('/api/reports', requireAuth, tenantRateLimit, requireModuleAccess('reports'), reportsV2Router);
app.use('/api/reports', requireAuth, tenantRateLimit, requireModuleAccess('reports'), reportsRouter);
```

(v2 mounted first, legacy as fallback.)

### New report — Pre-Paid Reservations

`backend/src/modules/reports/pre-paid-reservations.report.js` +
`frontend/src/app/reports-v2/pre-paid-reservations/page.js`. Reads from
`ExternalReservation` rows (sourceSystem=TL, promotionStatus != REJECTED).
Filter by Year + Month on `pickupAt`. Grouped by pickup location. Per-branch
subtotals + grand total. Excel download via the existing reports-export
utility.

### Reports v2 bug fixes (from yesterday's rollback findings)

- **#16 availability-forecast:** was querying `Vehicle.status: { not: 'RETIRED' }`
  but the `VehicleStatus` enum has no `RETIRED` member. Changed to `OUT_OF_SERVICE`
  as the "exclude from forecast" sink.
- **#17 fleet-status:** "On rent" count was 0 even when individual rows showed
  active customers, because `Vehicle.status` isn't flipped to `ON_RENT` when an
  agreement opens (that's an app-level schema invariant bug we'll fix
  separately). The report now derives ON_RENT from the existence of an active
  reservation (`ACTIVE_RESERVATION_STATUSES`), not from `Vehicle.status`. KPIs
  match the row table now.

### Reservations module UX

- **Franchise import badge:** when `bookingChannel === 'FRANCHISE_TL'`, the row
  shows a blue rounded pill "Franchise import" next to the status badge.
  `bookingChannel` added to `reservationListSelect` so the API surfaces it.
- **Sort filter:** dropdown next to date filters. Options:
  - Newest created (default)
  - Pickup — oldest first
  - Pickup — newest first
  - Return — oldest first
  - Return — newest first
  Backend `listPage` accepts a `sort` query param mapped to a Prisma orderBy
  array; the cache key picks up the param so each sort gets its own slot.
- **Nav fix:** the "Reports" link in the sidebar used to go to `/reports`
  (legacy MVP). Now points to `/reports-v2`.

### Pending Imports tray (PendingFranchiseImportsTray)

This component lives at the top of the `/reservations` page when there are
TL bookings in MANUAL_REVIEW. Cleaned up extensively:

- **English-only:** removed every `es / en` bilingual concatenation in both
  the tray itself and the EditPromoteModal (column headers, action buttons,
  status reasons, modal section headers, button labels, confirm messages,
  loading states, error messages — all of them).
- **Overflow fix:** dropped `minWidth: 1200` to `900`, added `overflow: hidden`
  + `maxWidth: 100%` on the section so the table stays inside its card.
- **Modal scroll:** the Edit modal switched from `align-items: center` to
  `flex-start` + scrollable overlay + `padding-top` — the Promote button was
  unreachable on tall content before.
- **Promote unblock:** Promote button no longer requires Vehicle Category +
  Location overrides — only `customerId`. Backend auto-resolves the rest from
  TL ACRISS + Location mappings when available.
- **Sort dropdown** in the tray for the bandeja itself (Pickup/Return ×
  oldest/newest).

### TL Integration support API fixes

- `GET /api/admin/integrations/tl-international/runs` and `/pending-imports`:
  changed `resolveTenantId` to `resolveTenantIdOrNull` for these read-only
  endpoints so SUPER_ADMIN with no tenant override gets data across all
  tenants instead of a 500. Beta.56's runs-history page in particular
  couldn't pick a tenant (because `/api/admin/tenants` 404s in beta.56) and
  was throwing on every load.

### Check-in bug fixes

- **Balance epsilon:** in `checkin-close.service.js`, the routing decision
  between "send paid-in-full receipt" vs "send invoice email" was `<= 0` —
  rounding artifacts (0.001, 0.009) routed to invoice and the email said "we
  will charge your card" even though the customer was logically paid in full.
  Threshold is now `<= 0.01`.
- **Late return grace period:** `LATE_RETURN_GRACE_MINUTES` in
  `fee-engine.service.js` is now overridable via env var
  `LATE_RETURN_GRACE_MINUTES`, default 30. Per-tenant grace would need a
  schema migration (Settings.lateReturnGraceMinutes); deferred.
- **Early return:** the `computeLateReturnFee` function was already correct on
  this (returns null when `returnedAt < dueBackAt`). Confirmed by re-reading
  the code + test cases.

---

## Deploy ledger (today)

| Time      | Tag                                  | What |
|-----------|--------------------------------------|------|
| morning   | `v0.9.0-beta.56-tl-proxy`            | Residential proxy fix only (cherry-picked from main onto beta.56 base) |
| afternoon | `v0.9.0-beta.56-tl-proxy-v2`         | + auto-create customer + Pending tray UX bilingual cleanup + /runs tolerant |
| evening   | `v0.9.0-beta.56-tl-reports`          | + Reports v2 (16 reports) + Pre-Paid + Reports bugs #16/#17 + check-in epsilon |
| evening   | `v0.9.0-beta.56-tl-reports-v2`       | + franchise-import badge + main-table sort dropdown |
| evening   | `v0.9.0-beta.56-tl-reports-v3`       | + TL status CONFIRMED + mount Reports v2 router in main.js |
| late      | `v0.9.0-beta.56-tl-reports-v4`       | + nav link /reports → /reports-v2 |
| late      | `v0.9.0-beta.56-tl-reports-v5`       | + Pre-Paid auto-refetch on month change (dropped draft state + Search button) |

---

## Pending — for the next session

### Reports — audit pass

Hector wants to go report-by-report through all 17 of them and surface
whatever's wrong:

- **Pre-Paid Reservations** — current concern: when changing the month
  dropdown the data didn't update (turned out v5 deploy wasn't run; fix
  itself was correct). Re-validate that month switch works after v5 deploys.
  Also audit:
  - Booking Date column source — currently uses `firstSeenAt` (when we
    synced) but mockup labels it as TL's booking date. May want to map from
    `rawJson` if TL stores the original booking timestamp.
  - Whether "all months" / "year-to-date" view is wanted instead of single
    month.
- Walk through each of the other 16 reports the same way. We had two known
  bugs (#16, #17) that we fixed; expect 2-3 more per report on first
  exposure with real data.

### Planner — auto-acomodar 400 Bad Request

Hector reported that the auto-accommodate feature in the Planner is throwing
**400 Bad Request**. Needs:

1. Capture the failing request from browser DevTools (URL, body, response)
2. Trace the backend handler that returns 400 — identify which validation
   it's tripping
3. Fix the input shape OR the validator

This was NOT touched today, so it's a real bug in current `beta.56` baseline.

### Dejavoo terminal — waiting on support

- Support call placed yesterday — they were going to enable the AutoRental
  feature pack on TPN `816026739983`.
- When support confirms, re-deploy the Dejavoo bundle (which sits on
  `origin/main` and includes the deposit double-charge fix + RentalClassId
  2201 fix from Sun night's work).
- Strategy: cherry-pick the Dejavoo files onto the current `proxy-on-beta56`
  branch + tag as `v0.9.0-beta.56-tl-reports-dejavoo` or similar — keeping
  the surface controlled.
- Smoke test: ONE complete real-card checkout to verify disclaimer +
  signature capture + signature → PDF flow.

### Smaller items (catalog, lower priority)

- **SUPER_ADMIN bypass in `requireModuleAccess`** — currently SUPER_ADMIN
  bypasses, but Hector experienced 403 because he tested as IRC ADMIN with
  `moduleAccess.reports !== true`. Workaround in place (impersonate or set
  moduleAccess via SQL). Could add a more permissive default in module-access
  config so ADMINs of tenants with the reports module enabled don't need a
  per-user override.
- **Per-tenant grace period setting** — `LATE_RETURN_GRACE_MINUTES` is now
  env-overridable, but a real per-tenant config (Settings table column or
  `tenant.settingsJson`) would let each tenant set their own.
- **TL pre-paid checkout flow** — for `bookingChannel === 'FRANCHISE_TL'`
  reservations, skip the payment step at checkout (already paid by TL).
  The badge is there; checkout logic needs a branch.
- **Bulk-promote in Pending Imports** — when there are dozens of MANUAL_REVIEW
  rows that are all legit, a "promote all visible" action would save a lot
  of clicks. Currently each one needs an individual Promote click (or Edit +
  fill + Promote).
- **TL cookie auto-rotation** — cookie expires every 25 min. Currently the
  cookie has to be manually pasted into Update Cookie when sync fails.
  Could automate via Puppeteer login (gated by 2FA — would need an
  authenticator integration; not trivial).

---

## State of the box

- **Production tag:** `v0.9.0-beta.56-tl-reports-v5`
- **Branch:** `proxy-on-beta56` (off `v0.9.0-beta.56`)
- **Origin:** github.com/hpadilla16/RideFleetManagement
- **DB:** Supabase (managed), Prisma pooler at `?pgbouncer=true`
- **Redis:** DigitalOcean managed (`rediss://…ondigitalocean.com:25061`)
- **Droplet:** `ubuntu-s-1vcpu-2gb-nyc3-01-ridefleetmanagement` (NYC3)
- **TL proxy:** Hector's PC Windows, Tailscale IP `100.120.215.18`,
  egress IP `70.125.52.151`
- **Env vars on droplet (relevant new):**
  - `TL_INTERNATIONAL_PROXY_URL=http://100.120.215.18:8888`
  - `TL_INTEGRATION_ENABLED=true`
  - `TL_AUTO_CREATE_CUSTOMERS=true`
  - `LATE_RETURN_GRACE_MINUTES` (unset = 30 default)
- **Containers (all healthy):** fleet-backend-prod, fleet-worker-prod,
  fleet-frontend-prod, fleet-db-prod

---

## Tomorrow's recommended sequence

1. **Confirm v5 fully deployed** — `git describe --tags HEAD` on droplet
   should show `v0.9.0-beta.56-tl-reports-v5`, and the month-switch in
   Pre-Paid Report should refetch + render the new month's 54 records.
2. **Planner 400 — first thing, blocks ops** — capture failing request from
   DevTools, find handler, fix.
3. **Reports audit pass** — walk through each of the 17 reports with real
   data, log every issue found, fix in batches.
4. **Dejavoo redeploy** — assuming support confirmed AutoRental feature pack.

`beta.72` Dejavoo bundle is ready to ship the moment support gives the green
light. Don't bundle the Dejavoo redeploy with anything else — single-purpose
tag (`v0.9.0-beta.56-tl-reports-dejavoo`) so smoke test focuses on the one
thing.
