#!/usr/bin/env bash
# =====================================================================
# Ship the SUPER_ADMIN reservation status override panel as v0.9.0-beta.60
# Run from your Mac (NOT the sandbox — the FUSE mount can't free
# .git/index.lock). Run from the repo root:
#     bash .deploy-notes/2026-06-02-ship-override-panel-beta60.sh
#
# NOTE vs the 2026-06-01 script: we did NOT cherry-pick 7dce549. That
# backend route depended on schema (ReservationSigning, DejavooTransaction,
# rentalFeeCollected*) that does NOT exist on release/v0.9.0-beta.58, so it
# would 500 on every call. The route here is an ADAPTED version written
# directly into the working tree. The four files below are all that ships.
# =====================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH_EXPECTED="release/v0.9.0-beta.58"
TAG="v0.9.0-beta.60"

echo "→ Repo:   $REPO_ROOT"
echo "→ Branch: $(git branch --show-current)  (expected: $BRANCH_EXPECTED)"
echo "→ Tag:    $TAG"
echo

if [ "$(git branch --show-current)" != "$BRANCH_EXPECTED" ]; then
  echo "✗ Not on $BRANCH_EXPECTED. Checkout that branch first, then re-run." >&2
  exit 1
fi

# The Cowork sandbox leaves a stale 0-byte .git/index.lock behind (it can't
# unlink it over the FUSE mount). Clear it so git can stage — but only if no
# git process is actually running.
if [ -f .git/index.lock ]; then
  if pgrep -x git >/dev/null 2>&1; then
    echo "✗ .git/index.lock exists AND a git process is running. Resolve manually." >&2
    exit 1
  fi
  echo "→ Removing stale .git/index.lock"
  rm -f .git/index.lock
fi

FILES=(
  "backend/src/main.js"
  "backend/src/modules/admin/reservation-override.routes.js"
  "frontend/src/components/admin/ReservationOverridePanel.jsx"
  "frontend/src/app/reservations/[id]/page.js"
)

echo "→ Files to ship:"
for f in "${FILES[@]}"; do
  [ -e "$f" ] || { echo "✗ Missing: $f" >&2; exit 1; }
  echo "    $f"
done
echo

echo "→ Diff summary:"
git add -- "${FILES[@]}"
git status --short -- "${FILES[@]}"
echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted (changes left staged)."; exit 0; }

git commit -m "feat(admin-ui): SUPER_ADMIN reservation status override panel

Adapted reservation-override route to the release/v0.9.0-beta.58 schema
(no ReservationSigning / DejavooTransaction models, no rentalFeeCollected*
fields on this branch). Ships:
  - backend/src/modules/admin/reservation-override.routes.js (adapted)
  - backend/src/main.js  (mount under requireRole('SUPER_ADMIN'))
  - frontend/src/components/admin/ReservationOverridePanel.jsx
  - frontend/src/app/reservations/[id]/page.js  (mount the panel)

Override does: status set + smart rewind (orphan RentalAgreement delete via
cascade, clear signature fields, reset paymentStatus), Vehicle.status sync
(respects IN_MAINTENANCE/OUT_OF_SERVICE), and an ADMIN_OVERRIDE AuditLog row.
paymentsForManualRefund is [] on this branch (no row-level Dejavoo tracking)."

git tag "$TAG"
git push origin "$BRANCH_EXPECTED" "$TAG"

echo
echo "✓ Pushed $BRANCH_EXPECTED and $TAG."
echo
echo "Next — deploy on the droplet:"
cat <<'EOF'
  cd ~/RideFleetManagement
  git fetch --tags --force
  git checkout v0.9.0-beta.60
  docker compose -f docker-compose.prod.yml down
  docker compose -f docker-compose.prod.yml up -d --build
  sleep 60
  docker compose -f docker-compose.prod.yml ps
  docker logs fleet-backend-prod --tail 30
EOF
