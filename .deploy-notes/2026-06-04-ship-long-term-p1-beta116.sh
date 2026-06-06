#!/usr/bin/env bash
# v0.9.0-beta.116 — Long-Term (Monthly) Reservations P1+P2 (schema, module, UI, billing automation).
#   bash .deploy-notes/2026-06-04-ship-long-term-p1-beta116.sh
# RUN AFTER beta.115 is deployed + verified. ATOMIC: main.js mounts the module,
# so all files below must ship together or the backend won't boot.
# Monthly is EXPLICIT opt-in at creation (rate from RateItem.monthly, locked);
# daily reservations NEVER auto-convert at 28+ days. Cycles bill as
# MONTHLY_CYCLE charges via the staff "Bill Next Cycle" button (P1 manual;
# P2 adds worker/autocharge/dunning/pay-link).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
# ── PRE-FLIGHT: env KEY-NAME parity check (names only, never values) ──────────
# Catches the bug class where a var was added to backend/.env.example but never
# set on the prod droplet (already caused a 500 on Supabase Storage uploads).
# MANUAL step on purpose: it needs YOUR authorized droplet SSH (the restricted
# ride-log-agent key is log-dump-only and cannot read the prod .env). Run it
# from your deployer machine BEFORE committing; it exits non-zero if any
# .env.example key is missing in prod OR the droplet is unreachable:
#   bash scripts/env-diff-check.sh
# Left as a commented pre-flight (not auto-run) so this atomic ship script's
# flow isn't broken by an SSH/network failure unrelated to the code change —
# but DO run it before answering 'y' to the commit prompt below.
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.116"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/main.js \
  && node --check src/modules/long-term/long-term.service.js \
  && node --check src/modules/long-term/long-term.routes.js \
  && node --check src/modules/reservations/reservations.service.js \
  && node --check src/modules/rental-agreements/rental-agreements.service.js \
  && node --check src/modules/auth/auth.service.js \
  && node --check src/modules/auth/auth.routes.js \
  && node --check src/lib/cache.js \
  && node --check src/lib/prisma.js \
  && node --check src/lib/logger.js \
  && node --check src/modules/reports/availability-forecast.report.js \
  && node --check src/modules/rental-agreements/checkin-close.service.js \
  && node --check src/modules/incident-report/incident-report.service.js \
  && node --check src/modules/checkout-session/checkout-session.service.js \
  && node --check src/modules/integrations/tl-international/tl-international.routes.js \
  && node --check src/modules/vehicles/vehicle-status-sync.js \
  && node --check src/modules/vehicles/vehicle-status-sweep.poll.js \
  && node --check src/modules/checkout-session/checkout-session.service.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260603_long_term_plans"
  "backend/prisma/migrations/20260604_card_on_file_type"
  "backend/prisma/migrations/20260604_screen_lock_exempt"
  "backend/prisma/migrations/20260605_perf_indexes"
  "backend/src/modules/auth/auth.service.js"
  "backend/src/modules/auth/auth.routes.js"
  "backend/src/lib/cache.js"
  "backend/src/lib/prisma.js"
  "backend/src/lib/logger.js"
  "frontend/src/app/loaner/checkout/[reservationId]/page.js"
  "frontend/src/components/AppShell.jsx"
  "frontend/src/app/settings/security/page.js"
  "backend/src/modules/payment-gateway/spin-client.js"
  "backend/src/modules/checkout-session/spin-charge.service.js"
  "backend/src/modules/checkout-session/checkout-session.service.js"
  "backend/src/modules/rental-agreements/checkin-close.service.js"
  "backend/src/modules/incident-report/incident-report.service.js"
  "backend/src/modules/reports/availability-forecast.report.js"
  "backend/src/modules/integrations/tl-international/tl-international.routes.js"
  "backend/src/modules/vehicles/vehicle-status-sync.js"
  "backend/src/modules/vehicles/vehicle-status-sweep.poll.js"
  "frontend/src/app/settings/page.js"
  "backend/src/main.js"
  "backend/src/worker.js"
  "backend/src/modules/long-term"
  "backend/src/modules/market-observations"
  "backend/src/modules/pricing-suggestions"
  "backend/src/modules/settings/settings.routes.js"
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "frontend/src/app/reservations/page.js"
  "frontend/src/app/reservations/[id]/page.js"
  "frontend/src/app/reservations/[id]/checkin-wizard/page.js"
  "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js"
  "frontend/src/app/reservations/[id]/payments/page.js"
  "frontend/src/app/layout.js"
  "doc/long-term-reservations-plan-2026-06-03.md"
  "doc/long-term-reservations-mockups-2026-06-03.html"
  ".deploy-notes/2026-06-04-ship-long-term-p1-beta116.sh"
  "scripts/env-diff-check.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "feat(long-term): Monthly reservations P1+P2 - plans, cycles, automated billing + dunning

P2: hourly billing scheduler (reminders 48h/24h before due, card-on-file
auto-charge on due date, 3-attempt retry, 1-day grace, overdue emails every
24h with auto-stop on payment, plan-ended email), tenant-configurable email
templates (GET/PUT /api/settings/long-term-email-templates), MANUAL mode.

LongTermPlan + BillingCycle schema (additive migration); /api/long-term module
(attach plan from RateItem.monthly locked at booking, staff close-cycle billing
with MONTHLY_CYCLE charges + auto-extend, mark-paid); agreement base charge
becomes Monthly Cycle 1 when a plan exists; create-form Monthly toggle (explicit
opt-in only, never inferred from duration); reservation detail plan panel with
cycle table; list shows LONG-TERM badge + Vehicle/Next Cycle/Balance columns.
Also: check-in wizard restyled to match the checkout wizard visual system
(step tracker, cards, buttons, pills) - presentation only, logic untouched.
Also: debit-aware deposits - cardOnFileType captured at the sale tap, per-
location securityDepositAmountDebit uplift on the hold (raise-only), agent
advisory in the wizard, settings field in the Locations editor.
Also: anti-AI-copying honeypot in root layout - hidden notice + duck-store
decoy HTML readable only by scraping agents (display:none, aria-hidden,
data-nosnippet; zero impact on users, SEO, or perf).
Also: per-user screen-lock exemption (User.screenLockExempt + additive
migration, ADMIN toggle in Settings > Security, AppShell skips idle lock) -
for the read-only ops/reporting agent account (ircadmin).
Also: redis pingInterval (4m) on the cache pub/sub clients - stops the
constant Upstash idle-disconnect 'Socket closed unexpectedly' log loop.
Also: loaner-return routing fix - DEALERSHIP_LOANER reservations route
Start Check-in to /loaner/checkin/[id] (the generic wizard dead-ended on a
null rentalAgreement); plus inline 'why is Continue disabled' hints in the
check-in and loaner-checkout wizards.
Also: PII-log hardening - Prisma slow-query param VALUES suppressed in prod
(timing/SQL text kept), winston redact format masks name/phone/email/dob/
license/cardOnFileToken/ssn/password and truncates base64 image payloads.
Also: scripts/env-diff-check.sh pre-flight - fails the deploy if a
.env.example key name is missing on the prod droplet (names only).
Also: Authorize.Net auto-reconcile poll limited (payments page) - WEB-
reservations only, exponential backoff 15s->2m cap, 6 attempts max (was 12
x 15s for any unpaid reservation - the 400-loop the log monitor flagged);
manual Reconcile button unchanged.
Also: perf batch - availability-forecast TZ-flooring precomputed+memoized
(8.2s->0.17s on synthetic), photosJson dropped from 3 selects that never
read it (saveInspection, checkin-close, incident-create), 2 additive
indexes (Reservation tenantId+returnAt+pickupAt, VehicleTelematicsEvent
vehicleId+eventAt DESC) via migration 20260605_perf_indexes.
Also: checkout-wizard-v2 transition double-fire guard (in-flight ref) +
409-as-noop refetch when session already at/past target step; backend
transition logic untouched (comment only).
Also: GET /api/admin/integrations/tl-international/status implemented -
the settings panel has polled it since it shipped but the route never
existed (the recurring tl-status 404 in droplet logs); read-only summary,
never returns the cookie.
Also: vehicle-status drift hardening (KII873 incident) - sync now treats
reservation.vehicleId as source of truth and releases a stale swap vehicle;
new hourly worker sweep (vehicle-status-sweep.poll) repairs ON_RENT/AVAILABLE
drift both directions and WARNs when it fixes anything. Prod data: KII873 +
7 other vehicles had drifted (incl. AVAILABLE-while-rented = double-book
risk) and were repaired.
Also: NO-CAR-NO-CHECKOUT guard - checkout session start rejects 422
NO_VEHICLE_ASSIGNED and finalize hard-fails if reservation has no vehicle
(was producing CHECKED_OUT reservations + FINALIZED agreements with no car
on the contract); step-1 button disabled with reason in the wizard. Prod
data: 10 finalized agreements back-filled from reservation.vehicleId; 5
truly carless CHECKED_OUT reservations flagged for manual assignment."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy: git checkout v0.9.0-beta.116 && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "Pre-check in Supabase: SELECT to_regclass('\"LongTermPlan\"');  -- expect NULL before deploy"
