#!/usr/bin/env bash
# =====================================================================
# Ship the Incident / Damage Report module as v0.9.0-beta.62.
# Run from your Mac (NOT the sandbox), repo root:
#     bash .deploy-notes/2026-06-02-ship-incident-module-beta62.sh
#
# IMPORTANT — this is the first feature on this branch with a PROD SCHEMA
# MIGRATION. The migration must be applied to Supabase BEFORE the beta.62
# backend image boots, or the incident endpoints 500 on missing tables.
# This script only does git (commit/tag/push). The migration + droplet
# deploy steps are printed at the end — follow them in order.
# =====================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH_EXPECTED="release/v0.9.0-beta.58"
TAG="v0.9.0-beta.62"

echo "→ Branch: $(git branch --show-current)  (expected: $BRANCH_EXPECTED)"
[ "$(git branch --show-current)" = "$BRANCH_EXPECTED" ] || { echo "✗ Wrong branch." >&2; exit 1; }

if [ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1; then
  echo "→ Removing stale .git/index.lock"; rm -f .git/index.lock
fi

FILES=(
  "backend/src/modules/incident-report/incident-report.routes.js"
  "backend/src/modules/incident-report/incident-report.service.js"
  "backend/src/modules/incident-report/incident-report.service.test.mjs"
  "backend/src/modules/incident-report/incident-report-pdf.js"
  "backend/src/modules/incident-report/incident-report-pdf.test.mjs"
  "backend/src/main.js"
  "backend/package.json"
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260601_add_incident_report/migration.sql"
  "frontend/src/components/incident/IncidentReportsPanel.jsx"
  "frontend/src/app/settings/agreement-clauses/page.js"
  "frontend/src/app/reservations/[id]/page.js"
  "doc/incident-report-module-plan-2026-06-02.md"
  ".deploy-notes/2026-06-02-ship-incident-module-beta62.sh"
)

echo "→ Files to ship:"
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "✗ Missing: $f" >&2; exit 1; }; echo "    $f"; done
echo

echo "→ prisma validate..."
( cd backend && npx prisma validate ) || { echo "✗ prisma validate failed." >&2; exit 1; }
echo
echo "→ Running incident tests (exit code gated)..."
if ( cd backend && node --test --test-force-exit src/modules/incident-report/incident-report-pdf.test.mjs src/modules/incident-report/incident-report.service.test.mjs ); then
  echo "  ✓ tests passed"
else
  echo "✗ Tests failed — aborting." >&2; exit 1
fi
echo

git add -- "${FILES[@]}"
git status --short -- "${FILES[@]}"
echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted (changes left staged)."; exit 0; }

git commit -m "feat(incident): Reservation incident / damage report module (beta.62)

Ports the incident-report backend (service + routes + light-theme PDF +
clause library) from feature/incident-report onto the release branch, adapts
nothing (deps present here), adds the 3 models + 4 enums + back-relations to
schema.prisma and the additive 20260601_add_incident_report migration. New UI:
reservation Incident reports panel (list + DRAFT builder with evidence, clause
picker, signature, certify & issue, revise, print/PDF) and a Settings ->
Agreement clauses library page.

NOTE: the migration must be applied to Supabase before this image boots."

git tag "$TAG"
git push origin "$BRANCH_EXPECTED" "$TAG"
echo "✓ Pushed $BRANCH_EXPECTED and $TAG."

cat <<'EOF'

=====================================================================
PROD ROLLOUT — run these IN ORDER (migration BEFORE the new image):
=====================================================================

1) BACK UP the prod DB first (on the droplet):
     cd ~/RideFleetManagement && bash ops/backup.sh

2) (Optional dry-run) In the Supabase SQL editor, paste the migration
   wrapped in a transaction to confirm it applies clean, then ROLLBACK:
       BEGIN;
       <contents of backend/prisma/migrations/20260601_add_incident_report/migration.sql>
       ROLLBACK;

3) APPLY for real — paste the same migration.sql and run it (no wrapper).
   It is additive + idempotent (DO $$ IF NOT EXISTS for enums,
   CREATE TABLE IF NOT EXISTS) so it is safe to run once or re-run.
   Verify:  \d "ReservationIncident"   (and IncidentEvidence, AgreementClause)

4) DEPLOY the image on the droplet:
     cd ~/RideFleetManagement
     git fetch --tags --force
     git checkout v0.9.0-beta.62
     docker compose -f docker-compose.prod.yml up -d --build
     sleep 60
     docker compose -f docker-compose.prod.yml ps
     docker logs fleet-backend-prod --tail 30

5) SMOKE TEST:
     - Settings -> Agreement clauses -> "Seed default clauses" (then review text).
     - Open a reservation -> Incident reports -> New -> add evidence, cite a
       clause, sign, Certify & issue -> Preview/PDF opens the report.
=====================================================================
EOF
