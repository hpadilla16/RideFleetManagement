#!/usr/bin/env bash
# =====================================================================
# Ship bug #44 fix (Vehicle.status <-> Reservation.status sync) as
# v0.9.0-beta.61. Run from your Mac (NOT the sandbox), repo root:
#     bash .deploy-notes/2026-06-02-ship-vehicle-status-sync-beta61.sh
#
# Backend-only change. Adds a shared vehicle-status-sync helper and calls it
# at every Reservation.status writer (checkout, check-in, agreement lifecycle,
# admin PATCH) + refactors the override route to use it. Only CHECKED_OUT ->
# ON_RENT; every other status -> AVAILABLE. Never overwrites IN_MAINTENANCE /
# OUT_OF_SERVICE / SOLD.
# =====================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH_EXPECTED="release/v0.9.0-beta.58"
TAG="v0.9.0-beta.61"

echo "→ Repo:   $REPO_ROOT"
echo "→ Branch: $(git branch --show-current)  (expected: $BRANCH_EXPECTED)"
echo "→ Tag:    $TAG"
echo

if [ "$(git branch --show-current)" != "$BRANCH_EXPECTED" ]; then
  echo "✗ Not on $BRANCH_EXPECTED. Checkout that branch first, then re-run." >&2
  exit 1
fi

# Clear the stale 0-byte .git/index.lock the Cowork sandbox leaves behind.
if [ -f .git/index.lock ]; then
  if pgrep -x git >/dev/null 2>&1; then
    echo "✗ .git/index.lock exists AND a git process is running. Resolve manually." >&2
    exit 1
  fi
  echo "→ Removing stale .git/index.lock"
  rm -f .git/index.lock
fi

FILES=(
  "backend/package.json"
  "backend/src/modules/vehicles/vehicle-status-sync.js"
  "backend/src/modules/vehicles/vehicle-status-sync.test.mjs"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/rental-agreements/rental-agreements-finalize-tx.test.mjs"
  "backend/src/modules/rental-agreements/checkin-close.service.js"
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/admin/reservation-override.routes.js"
)

echo "→ Files to ship:"
for f in "${FILES[@]}"; do
  [ -e "$f" ] || { echo "✗ Missing: $f" >&2; exit 1; }
  echo "    $f"
done
echo

# Optional but recommended: run the touched tests before shipping.
# Use node --test's own exit code (0 = all passed) rather than grepping output,
# since the reporter format differs across Node versions.
echo "→ Running vehicle + finalize tests..."
if ( cd backend && node --test --test-force-exit \
      src/modules/vehicles/vehicle-status-sync.test.mjs \
      src/modules/rental-agreements/rental-agreements-finalize-tx.test.mjs ); then
  echo "  ✓ tests passed"
else
  echo "✗ Tests failed — aborting." >&2
  exit 1
fi
echo

git add -- "${FILES[@]}"
git status --short -- "${FILES[@]}"
echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted (changes left staged)."; exit 0; }

git commit -m "fix(fleet): sync Vehicle.status with Reservation.status (bug #44)

Vehicle.status drifted because checkout never set ON_RENT and check-in never
set it back to AVAILABLE, so returned cars looked rented (un-bookable) and
rented cars looked free. Adds a single source of truth:
  backend/src/modules/vehicles/vehicle-status-sync.js
and calls it at every Reservation.status writer:
  - counter checkout finalize (CHECKED_OUT -> ON_RENT, in the same tx)
  - check-in close (CHECKED_IN / CHECKED_IN_UNPAID -> AVAILABLE)
  - agreement lifecycle (VOID/REACTIVATE/START_CHECK_IN)
  - admin reservation PATCH (only when status changes)
  - override route refactored to import the shared helper

Mapping: only CHECKED_OUT is ON_RENT; every other status is AVAILABLE
(CHECKED_IN_UNPAID frees the car — it is physically returned). Never
overwrites IN_MAINTENANCE / OUT_OF_SERVICE / SOLD. Unit tests included."

git tag "$TAG"
git push origin "$BRANCH_EXPECTED" "$TAG"

echo
echo "✓ Pushed $BRANCH_EXPECTED and $TAG."
echo
echo "Next — deploy on the droplet:"
cat <<'EOF'
  cd ~/RideFleetManagement
  git fetch --tags --force
  git checkout v0.9.0-beta.61
  docker compose -f docker-compose.prod.yml up -d --build
  sleep 60
  docker compose -f docker-compose.prod.yml ps
  docker logs fleet-backend-prod --tail 30
EOF
