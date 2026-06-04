#!/usr/bin/env bash
# v0.9.0-beta.111 — incident reportNumber collision fix (backend only).
#   bash .deploy-notes/2026-06-03-ship-incident-reportnumber-beta111.sh
#
# Sentry (2026-06-03 10:55 ET): PrismaClientKnownRequestError "Unique
# constraint failed on (reportNumber)" at reservationIncident.create.
# reportNumber format INC-YYYYMMDD-PLATE is @unique → a SECOND incident for
# the same vehicle on the same day always collided (500 to the agent).
# Fix: nextReportNumber() appends a sequence suffix on collision
# (INC-20260603-KST788, then -2, -3, …).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.111"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/incident-report/incident-report.service.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/incident-report/incident-report.service.js"
  ".deploy-notes/2026-06-03-ship-incident-reportnumber-beta111.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(incident): sequence-suffix report numbers on same-day same-vehicle collisions

INC-YYYYMMDD-PLATE is @unique, so a second incident for the same vehicle on
the same day always threw P2002 and 500'd the agent (Sentry 2026-06-03).
nextReportNumber() counts existing reports with the same base and appends
-2, -3, ... on collision."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy (backend only):"
echo "  git checkout v0.9.0-beta.111 && docker compose -f docker-compose.prod.yml build backend worker && docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps backend worker"
