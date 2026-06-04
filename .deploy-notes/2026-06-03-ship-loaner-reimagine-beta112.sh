#!/usr/bin/env bash
# v0.9.0-beta.112 — Loaner Reimagine port (backend + frontend + 2 additive migrations).
#   bash .deploy-notes/2026-06-03-ship-loaner-reimagine-beta112.sh
# RUN AFTER the beta.111 ship script (incident reportNumber fix) — separate commits.
#
# Selective port from feature/loaner-reimagining (NOT a branch merge — the branch
# carries stale round-25/26 copies that release already superseded via Dejavoo):
#   • LoanerAgreement/LoanerPhoto/LoanerDamagePoint models + 2 additive migrations
#   • loaner-agreement module (routes/service/tests) + reminders scheduler (SMS)
#   • In-bay check-out wizard, return/check-in wizard, remote signing page,
#     customer self-service portal, PDF417 license scanner (@zxing + AAMVA)
#   • Command Center rewire of /loaner page; main.js mounts; worker wiring
# RETROFITS applied during port (code predates today's fixes):
#   • normalizeDob on borrower DOB (TL "age 1076" class)
#   • sign→ACTIVE advances Reservation→CHECKED_OUT + vehicle-status sync
#   • checkIn→RETURNED advances Reservation→CHECKED_IN + vehicle-status sync
#   • swap-vehicle fix skipped (already in release, 2026-05-23)
# Validated: prisma schema valid; node --check all backend; JSX parse all frontend;
# import resolution; migrations additive-only. Loaner tests run at Docker build.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.112"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/main.js && node --check src/worker.js \
  && node --check src/modules/dealership-loaner/loaner-agreement.service.js \
  && node --check src/modules/dealership-loaner/loaner-agreement.routes.js \
  && node --check src/modules/dealership-loaner/loaner-reminders.scheduler.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/package.json"
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260531_add_loaner_agreement"
  "backend/prisma/migrations/20260601_add_loaner_portal_token"
  "backend/src/main.js"
  "backend/src/worker.js"
  "backend/src/modules/dealership-loaner/loaner-agreement.routes.js"
  "backend/src/modules/dealership-loaner/loaner-agreement.service.js"
  "backend/src/modules/dealership-loaner/loaner-agreement.test.mjs"
  "backend/src/modules/dealership-loaner/loaner-reminders.scheduler.js"
  "backend/src/modules/dealership-loaner/loaner-reminders.test.mjs"
  "frontend/package.json"
  "frontend/src/app/loaner/page.js"
  "frontend/src/app/loaner/checkout/[reservationId]/page.js"
  "frontend/src/app/loaner/checkin/[reservationId]/page.js"
  "frontend/src/app/customer/sign-loaner/page.js"
  "frontend/src/app/customer/loaner-status/page.js"
  "frontend/src/components/loaner/LicenseScanner.jsx"
  "frontend/src/lib/aamva.js"
  "doc/loaner-phase3-prep-2026-06-01.md"
  "doc/session-handoff-2026-06-03.md"
  ".deploy-notes/2026-06-03-ship-loaner-reimagine-beta112.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "feat(loaner): Loaner Reimagine — in-bay wizard, remote signing, portal, license scan

Selective port from feature/loaner-reimagining: LoanerAgreement/Photo/DamagePoint
schema + migrations, agreement service/routes, SMS reminders scheduler, in-bay
check-out + return wizards, remote signing, customer portal, PDF417 license
autofill. Retrofitted with today's fixes: normalizeDob on borrower DOB, and
reservation+vehicle status sync on sign (CHECKED_OUT) and check-in (CHECKED_IN)."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy:"
echo "  git checkout v0.9.0-beta.112 && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo "Migrations are additive; verify prod lacks loaner tables first:"
echo "  SELECT to_regclass('\"LoanerAgreement\"');   -- expect NULL before deploy"
