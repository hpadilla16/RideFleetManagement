#!/usr/bin/env bash
# =====================================================================
# Ship as v0.9.0-beta.65 — consolidated (supersedes the unshipped beta.64).
# Run from your Mac, repo root:
#     bash .deploy-notes/2026-06-02-ship-autocharge-config-beta65.sh
#
# Contents (frontend + backend, NO schema migration):
#   1. Tenant-configurable post-check-in autocharge (Settings → Payments):
#        - mode AUTO / MANUAL
#        - AUTO: charge N hours after check-in (default 24)
#        - MANUAL: no background charge; balance collected in View Payments
#      Wired into checkin-close.service.js (reads the tenant config; honors
#      mode + delayHours; MANUAL skips the autocharge job).
#   2. Settings Hub "Agreement Clauses" chip (from beta.64, folded in here).
#   3. Docs: incident playbook, Dejavoo readiness review, check-in↔Dejavoo
#      fee-collection alignment, handoff update.
#
# This build also carries everything from beta.63 (photosJson pull fix + nav
# link), so a single beta.65 deploy covers betas 63–65.
# =====================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH_EXPECTED="release/v0.9.0-beta.58"
TAG="v0.9.0-beta.65"

echo "→ Branch: $(git branch --show-current)  (expected: $BRANCH_EXPECTED)"
[ "$(git branch --show-current)" = "$BRANCH_EXPECTED" ] || { echo "✗ Wrong branch." >&2; exit 1; }
if [ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1; then echo "→ clearing stale index.lock"; rm -f .git/index.lock; fi

FILES=(
  "backend/src/modules/settings/settings.service.js"
  "backend/src/modules/rental-agreements/checkin-close.service.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/reservations/autocharge.worker.js"
  "backend/src/lib/dob.js"
  "backend/src/lib/dob.test.mjs"
  "backend/src/modules/customers/customers.service.js"
  "backend/src/modules/customer-portal/customer-portal.routes.js"
  "backend/src/modules/reservations/reservation-additional-drivers.service.js"
  "backend/package.json"
  "frontend/src/app/settings/page.js"
  "frontend/src/app/settings/settings-constants.js"
  "doc/incident-reporting-playbook-2026-06-02.html"
  "doc/dejavoo-readiness-review-2026-06-02.md"
  "doc/checkin-fee-collection-dejavoo-alignment-2026-06-02.md"
  "doc/deploy-readiness-beta65-2026-06-02.md"
  "doc/bugs/2026-06-02-implausible-dob-blocks-checkout.md"
  "doc/fixes/2026-06-02-implausible-dob-sweep.sql"
  "doc/session-handoff-2026-06-02.md"
  ".deploy-notes/2026-06-02-ship-settings-clauses-chip-beta64.sh"
  ".deploy-notes/2026-06-02-ship-autocharge-config-beta65.sh"
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "✗ Missing: $f" >&2; exit 1; }; done

echo "→ prisma validate (schema unchanged, sanity only)..."
( cd backend && npx prisma validate ) || { echo "✗ prisma validate failed." >&2; exit 1; }
echo "→ backend syntax check..."
( cd backend && node --check src/modules/settings/settings.service.js && node --check src/modules/rental-agreements/checkin-close.service.js && node --check src/lib/dob.js ) || { echo "✗ syntax check failed." >&2; exit 1; }
echo "→ DOB sanitizer tests..."
( cd backend && node --test --test-force-exit src/lib/dob.test.mjs ) || { echo "✗ dob tests failed." >&2; exit 1; }
echo "  ✓ checks passed"
echo

git add -- "${FILES[@]}"
git status --short -- "${FILES[@]}"
echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted (changes left staged)."; exit 0; }

git commit -m "feat(payments): tenant-configurable post-check-in autocharge (AUTO/MANUAL + delay) + settings clauses chip

- Settings → Payments: 'Post-check-in autocharge' — mode AUTO/MANUAL and, for
  AUTO, 'charge N hours after check-in' (default 24h). Stored on the per-tenant
  payment-gateway config (default + read-merge + write-validation, clamp 0-720h).
- checkin-close.service.js honors it: MANUAL leaves the balance for staff in the
  View Payments tab (autochargeAt=null, no job enqueued); AUTO stamps autochargeAt
  and enqueues the charge at the configured delay.
- Settings Hub 'Agreement Clauses' chip (folded in from beta.64).
- HOTFIX: implausible date-of-birth no longer blocks checkout. New lib/dob.js
  normalizeDob() sanitizes DOB at every write path (garbage → null, agent
  re-enters); finalize gate gives a clear 'correct the date of birth' message
  instead of 'age 1067 exceeds maximum'. Incident TL-ZE40789836BA. Sweep SQL +
  bug write-up included.
- Docs: incident playbook, Dejavoo readiness review, check-in fee-collection
  alignment, DOB bug annotation, handoff."
git tag "$TAG"
git push origin "$BRANCH_EXPECTED" "$TAG"
echo "✓ Pushed $BRANCH_EXPECTED and $TAG."

cat <<'EOF'

Deploy on the droplet (no migration):
  cd ~/RideFleetManagement
  git fetch --tags --force
  git checkout v0.9.0-beta.65
  docker compose -f docker-compose.prod.yml up -d --build
  sleep 60
  docker compose -f docker-compose.prod.yml ps

Then verify:
  - Settings → Payments shows "Post-check-in autocharge" (mode + hours).
  - Set MANUAL, check a car in with an unpaid balance → no autocharge fires;
    balance is collectible in the reservation's View Payments tab.
  - Set AUTO with a small delay → autocharge schedules at that delay.
  - Settings Hub shows the "Agreement Clauses" chip.
EOF
