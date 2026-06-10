#!/usr/bin/env bash
# v0.9.0-beta.150 — Phase 0 infra hardening (scaling plan §5.1–5.3).
#   bash .deploy-notes/2026-06-09-ship-phase0-hardening-beta150.sh
#
# HAS A MIGRATION (20260610_pg_trgm_search — ADDITIVE ONLY: extension + GIN
# indexes, no table/column/data changes). Stacks on beta.149
# (release/deposit-balance-fix-beta119).
#
# ZERO money code. rental-agreements.service.js is touched ONLY in the PDF
# render block (agreementPdfBuffer) — no charge/checkout/payment logic.
#
# WHAT (plan: doc/scaling-capacity-plan-2026-06-09.md):
#  1. fleet-db-prod REMOVED from docker-compose.prod.yml — prod runs on
#     Supabase; the local Postgres container was dead weight (~300+MB RAM).
#     Volume fleet_pg_data_prod is kept on disk (manual delete later).
#     Prod is now 3 containers, not 4.
#  2. Chromium off the API request path + capped:
#     - Toll auto-sync scheduler MOVED main.js → worker.js (the 15-min sweeps
#       scrape SunPass/AutoExpreso with headless Chromium → now in the worker
#       container, which also gains PUPPETEER_EXECUTABLE_PATH in compose).
#     - tolls.service no longer raw-launches a throwaway Chromium per sync —
#       uses the shared singleton via withPage().
#     - NEW global semaphore in lib/puppeteer-browser.js caps concurrent
#       Chromium pages per process (PUPPETEER_MAX_CONCURRENT_PAGES, default 2;
#       set in compose for backend + worker). Covers agreement PDFs, report/
#       inventory PDFs, toll scrapes, and (own browser, own cap) TL pages.
#     - PDF renders stay in the API container by design (1-3s on a warm
#       browser; offloading them through BullMQ hits Upstash's ~1MB payload
#       limit — revisit with storage-backed job results if ever needed).
#  3. pg_trgm + GIN trigram indexes for ILIKE '%term%' search on Vehicle
#     (internalNumber/plate/vin/make/model), Customer (first/last/email/phone
#     + both full-name expressions), Reservation (reservationNumber/sourceRef).
#     customers.service.js raw SQL rewritten LOWER() LIKE → ILIKE and
#     CONCAT() → || so every OR arm is indexable (CONCAT is STABLE → not
#     indexable; identical semantics).
#  4. .env.example gains SUPABASE_STORAGE_INVENTORY_BUCKET +
#     INSPECTION_PHOTOS_STORAGE_ENABLED so env-diff-check covers the
#     inventory-photos bucket setup (session-handoff 2026-06-09 follow-up).
#
# ⚠ BEFORE RUNNING THIS SCRIPT: add the two new keys to the droplet .env or
#   env-diff-check below will (correctly) fail:
#     SUPABASE_STORAGE_INVENTORY_BUCKET="inventory-photos"
#     INSPECTION_PHOTOS_STORAGE_ENABLED="false"   # flip to true once the bucket exists
#
# FILES:
#   docker-compose.prod.yml                                      db container out; worker chromium env; page-cap env
#   backend/src/lib/puppeteer-browser.js                         global page semaphore + withPage()/withTLPage()
#   backend/src/main.js                                          toll scheduler removed (moved to worker)
#   backend/src/worker.js                                        toll scheduler start/stop + chromium close on shutdown
#   backend/src/modules/tolls/tolls.service.js                   singleton withPage() instead of raw launches
#   backend/src/modules/rental-agreements/rental-agreements.service.js   agreementPdfBuffer → withPage()
#   backend/src/modules/reports/reports-export.js                renderReportPdf → withPage()
#   backend/src/modules/customers/customers.service.js           list search: ILIKE + || (index-servable)
#   backend/prisma/migrations/20260610_pg_trgm_search/migration.sql      additive trigram indexes
#   backend/.env.example                                         inventory bucket + photos flag keys
#   doc/scaling-capacity-plan-2026-06-09.md                      the capacity & scaling plan itself
#   .deploy-notes/2026-06-09-ship-phase0-hardening-beta150.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.150"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "docker-compose.prod.yml"
  "backend/src/lib/puppeteer-browser.js"
  "backend/src/main.js"
  "backend/src/worker.js"
  "backend/src/modules/tolls/tolls.service.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/reports/reports-export.js"
  "backend/src/modules/customers/customers.service.js"
  "backend/prisma/migrations/20260610_pg_trgm_search/migration.sql"
  "backend/.env.example"
  "doc/scaling-capacity-plan-2026-06-09.md"
  ".deploy-notes/2026-06-09-ship-phase0-hardening-beta150.sh"
)

# ── SYNTAX GATE. main.js AND worker.js both changed — a broken import in
#    either means a container that won't boot.
( cd backend \
  && node --check src/lib/puppeteer-browser.js \
  && node --check src/main.js \
  && node --check src/worker.js \
  && node --check src/modules/tolls/tolls.service.js \
  && node --check src/modules/rental-agreements/rental-agreements.service.js \
  && node --check src/modules/reports/reports-export.js \
  && node --check src/modules/customers/customers.service.js )
echo "node --check OK."

( cd backend && npx prisma validate >/dev/null ) && echo "prisma validate OK."

( cd backend && npm run -s test:puppeteer >/dev/null ) && echo "puppeteer-browser unit tests OK."
( cd backend && npm run -s test:tolls >/dev/null ) && echo "tolls unit tests OK."
( cd backend && npm run -s test:rental-agreements >/dev/null ) && echo "rental-agreements unit tests OK."

# ── GUARDS.
# No raw Chromium launches left in tolls (must go through the capped singleton):
! grep -nq "puppeteer.default.launch" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: raw puppeteer.launch still in tolls.service." >&2; exit 1; }
grep -nq "resolveTollWithPage" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: tolls not wired to withPage." >&2; exit 1; }
# Semaphore + withPage actually exported:
grep -nq "export const withPage" backend/src/lib/puppeteer-browser.js || { echo "ABORT: withPage export missing." >&2; exit 1; }
grep -nq "PUPPETEER_MAX_CONCURRENT_PAGES" backend/src/lib/puppeteer-browser.js || { echo "ABORT: page cap missing." >&2; exit 1; }
# Scheduler moved, not duplicated and not lost:
! grep -nq "TollAutoSyncScheduler" backend/src/main.js || { echo "ABORT: toll scheduler still referenced in main.js." >&2; exit 1; }
grep -nq "tolls.scheduler.js" backend/src/worker.js || { echo "ABORT: worker.js not starting toll scheduler." >&2; exit 1; }
# Compose: db gone, worker can find Chrome, caps set:
! grep -nq "container_name: fleet-db-prod" docker-compose.prod.yml || { echo "ABORT: fleet-db-prod still in prod compose." >&2; exit 1; }
! grep -nqE "^\s+db:|image: postgres" docker-compose.prod.yml || { echo "ABORT: local postgres service still in prod compose." >&2; exit 1; }
[ "$(grep -c "PUPPETEER_EXECUTABLE_PATH" docker-compose.prod.yml)" = "2" ] || { echo "ABORT: PUPPETEER_EXECUTABLE_PATH must be set for backend AND worker." >&2; exit 1; }
[ "$(grep -c "PUPPETEER_MAX_CONCURRENT_PAGES" docker-compose.prod.yml)" = "2" ] || { echo "ABORT: page cap must be set for backend AND worker." >&2; exit 1; }
docker compose -f docker-compose.prod.yml config -q && echo "compose config OK."
# Migration present + additive markers:
grep -nq "CREATE EXTENSION IF NOT EXISTS pg_trgm" backend/prisma/migrations/20260610_pg_trgm_search/migration.sql || { echo "ABORT: pg_trgm migration malformed." >&2; exit 1; }
! grep -nqE "DROP TABLE|DROP COLUMN|ALTER TABLE" backend/prisma/migrations/20260610_pg_trgm_search/migration.sql || { echo "ABORT: migration is not additive-only." >&2; exit 1; }
# Customer search must be index-servable (no CONCAT/LOWER-LIKE arms left):
! grep -nq "CONCAT(COALESCE" backend/src/modules/customers/customers.service.js || { echo "ABORT: CONCAT() still in customer search (not indexable)." >&2; exit 1; }
# New env keys present in the example file:
grep -nq "SUPABASE_STORAGE_INVENTORY_BUCKET" backend/.env.example || { echo "ABORT: inventory bucket key missing from .env.example." >&2; exit 1; }
grep -nq "INSPECTION_PHOTOS_STORAGE_ENABLED" backend/.env.example || { echo "ABORT: photos flag missing from .env.example." >&2; exit 1; }
echo "Guards OK."

echo
echo "⚠ env-diff-check will FAIL unless the droplet .env already has the two new keys"
echo "  (SUPABASE_STORAGE_INVENTORY_BUCKET, INSPECTION_PHOTOS_STORAGE_ENABLED)."
bash scripts/env-diff-check.sh || { echo "env-diff-check failed — add the keys to the droplet .env first." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "infra: Phase 0 hardening — drop local db container, chromium to worker + page cap, pg_trgm search indexes

- docker-compose.prod.yml: remove fleet-db-prod (prod is on Supabase; frees
  RAM on the box that breaks on RAM first). Prod = 3 containers now.
- Toll auto-sync scheduler moves main.js -> worker.js; toll scrapers use the
  shared Chromium singleton via withPage(); global per-process page cap
  (PUPPETEER_MAX_CONCURRENT_PAGES=2) covers PDFs + scrapers.
- Additive migration 20260610_pg_trgm_search: pg_trgm + GIN trigram indexes
  on Vehicle/Customer/Reservation search columns; customer raw search
  rewritten to ILIKE + || so every OR arm is index-servable.
- .env.example: inventory-photos bucket + flag keys (env-diff coverage).

Scaling plan: doc/scaling-capacity-plan-2026-06-09.md (Phase 0, §5.1-5.3).
No money code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG."
echo
echo "── PRE-FLIGHT on the droplet (BEFORE checkout) ─────────────────────────"
echo "  # 1. Confirm prod really reads Supabase, not the local container:"
echo "  docker exec fleet-backend-prod sh -c 'echo \$DATABASE_URL' | grep -q 'supabase' && echo DB=Supabase-OK"
echo "  # 2. Confirm nothing is connected to the local Postgres:"
echo "  docker exec fleet-db-prod psql -U postgres -d fleet_management -c \\"
echo "    \"SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend';\"   # expect ~1 (this psql)"
echo "  # 3. Add the two new keys to the droplet .env (see header of this script)."
echo
echo "── DEPLOY on the droplet ───────────────────────────────────────────────"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate --remove-orphans"
echo "  # --remove-orphans retires the old fleet-db-prod container."
echo "  # Volume fleet_pg_data_prod stays on disk — delete manually later if wanted."
echo
echo "  # MIGRATION (additive: pg_trgm + indexes) — SESSION port 5432, never 6543:"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); npx prisma migrate deploy'"
echo
echo "── VERIFY (a green push is NOT a green deploy) ─────────────────────────"
echo "  • 3 containers healthy (backend, worker, frontend) — fleet-db-prod GONE."
echo "  • Backend boot clean (no MODULE_NOT_FOUND/TypeError) + /health 200."
echo "  • Worker log shows: '[worker] started: toll-auto-sync scheduler'."
echo "  • ~15-20 min later: '[tolls] auto sync sweep' lines appear in the WORKER log"
echo "    (and NOT in the backend log)."
echo "  • Indexes landed:  SELECT indexname FROM pg_indexes WHERE indexname LIKE '%trgm%';  → 13 rows."
echo "  • RAM check: 'docker stats --no-stream' — expect a few hundred MB freed."
echo "  smoke: customer search ('Hector Padilla' full-name), vehicle search by plate,"
echo "         print one rental agreement PDF, download one inventory report PDF."
