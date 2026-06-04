#!/usr/bin/env bash
# v0.9.0-beta.114 — vehicle double-booking fix + phantom fuel-fee fix (no migration).
#   bash .deploy-notes/2026-06-04-ship-vehicle-conflict-gate-beta114.sh
# RUN AFTER beta.113 is verified. Stages ONLY the conflict-gate files (the
# uncommitted long-term P1 work ships separately later).
#
# BUG (Sentry 2026-06-04, RES-819679): a vehicle still out on an OPEN rental
# (never checked in, scheduled return in the past) was assigned + checked out
# to a second reservation. Two holes:
#   1. ensureNoVehicleConflict was date-overlap only — an overdue rental's
#      dates don't overlap a new reservation, so it passed.
#   2. The checkout-session wizard ran NO conflict check at all.
# FIX: open CHECKED_OUT rentals now conflict regardless of dates (409 with
# "check it in or swap first"); conflict errors carry statusCode 409 (was
# uncaught 500); wizard gates at session start AND at finalize (rethrown
# loudly, not swallowed).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.114"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/reservations/reservations.service.js && node --check src/modules/checkout-session/checkout-session.service.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/checkout-session/checkout-session.service.js"
  "backend/src/modules/fees/fee-engine.service.js"
  "frontend/src/components/wizard/useFeePreview.js"
  ".deploy-notes/2026-06-04-ship-vehicle-conflict-gate-beta114.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
echo "NOTE: longTermPlan list-select was deliberately removed - ships with the long-term tag"
echo "Everything long-term stays uncommitted."
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix: vehicle double-booking gate + phantom fuel-fee quantization

Fuel: checkout/check-in captured fuel at different precisions (0.375 vs 0.38)
so identical-looking gauge readings charged a phantom \$0.80 fee; both sides
now quantize to the nearest eighth (gauge resolution), engine + live preview.

ensureNoVehicleConflict now treats any open CHECKED_OUT reservation on the
vehicle as a conflict regardless of date overlap (overdue rentals' dates do
not overlap new bookings - RES-819679 double-booking). Conflict errors are
409s. The checkout-session wizard now runs the gate at session start and at
finalize, where conflicts rethrow loudly instead of being swallowed."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy (backend + frontend — fuel preview changed):"
echo "  git checkout v0.9.0-beta.114 && docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d --force-recreate"
