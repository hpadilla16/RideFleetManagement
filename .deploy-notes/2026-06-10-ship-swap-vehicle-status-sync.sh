#!/usr/bin/env bash
# POST /api/reservations/:id/swap-vehicle: sync Vehicle.status for BOTH cars
# (swapped-out -> AVAILABLE, replacement -> ON_RENT) inside the swap transaction.
#   bash .deploy-notes/2026-06-10-ship-swap-vehicle-status-sync.sh
#
# NOT a money path. No migrations. Single-file, additive change inside
# reservationsService.swapVehicle (reservations.service.js only — no
# payment/deposit/pricing/gateway code).
#
# WHY: swapVehicle (only allowed on CHECKED_OUT reservations) moves
# Reservation.vehicleId + RentalAgreement.vehicleId to the new car but never
# calls syncVehicleStatusForReservation — so the swapped-out car stays ON_RENT
# and the replacement stays AVAILABLE until the hourly vehicle-drift-sweep
# repairs both. Live proof: POST /api/reservations/<id>/swap-vehicle 200
# @2026-06-10T17:23:01Z followed by '[vehicle-drift-sweep] repaired' freed
# KII873 / rented KHV165 @17:29:28Z; same freed+rented pair signature @15:29Z
# (KST792/KQN763) and on 2026-06-08 (3 consecutive hourly repairs). Distinct
# write path from patch 06 (updateReservation): the loaner swap goes through
# reservationsService.update (patch 06 covers it); THIS direct swap path
# bypasses update() entirely.
#
# FIX: call syncVehicleStatusForReservation(tx, { vehicleId: current.vehicleId,
# reservationId: id, toStatus: 'CHECKED_OUT' }) as the last step of the swap
# transaction. The helper (beta.116 hardening) treats the reservation's current
# vehicle (= the NEW car post-update) as primary -> ON_RENT, and releases the
# passed stale vehicleId (= the swapped-out car) unless it is locked
# (IN_MAINTENANCE/OUT_OF_SERVICE/SOLD) or still CHECKED_OUT on another rental.
# Impact if NOT shipped: hourly drift WARNs + up to ~1h window where the
# dashboard/availability shows the wrong car as free/rented after every swap.
#
# Verified in sandbox @ HEAD e9359b3: git apply --check CLEAN; node --check OK
# on the patched file; vehicle-status-sync.test.mjs 9/9 pass (helper contract:
# stale release + locked-state + still-out cases covered). Patch is independent
# of staged patches 05/06/07/08 (different hunks/files) — ship in any order.
#
# NOTE: lands on release/deposit-balance-fix-beta119 (active prod line) which
# carries in-flight money WIP — deploying rebuilds the whole line, so the deploy
# is YOUR explicit call. Review the staged diff before committing.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
PATCH="ops/.agent-patches/09-swap-vehicle-status-sync.patch"
FILE="backend/src/modules/reservations/reservations.service.js"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN (next free beta) before running." >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

# ── APPLY the staged patch (working tree ships clean; agent never left edits).
if git apply --check "$PATCH" 2>/dev/null; then
  git apply "$PATCH"; echo "Applied $PATCH."
elif grep -q "Drift fix (2026-06-10): swapVehicle" "$FILE"; then
  echo "Patch already applied — continuing."
else
  echo "ABORT: $PATCH does not apply and the change is absent. Resolve manually." >&2; exit 1
fi

# ── SYNTAX GATE
( cd backend && node --check "src/modules/reservations/reservations.service.js" )
echo "node --check OK."

# ── UNIT GATE: sync-helper contract still green
node --test --test-force-exit backend/src/modules/vehicles/vehicle-status-sync.test.mjs >/dev/null \
  && echo "vehicle-status-sync tests OK." \
  || { echo "ABORT: vehicle-status-sync tests failed." >&2; exit 1; }

# ── GUARD: the sync call must be inside swapVehicle's transaction
grep -nq "Drift fix (2026-06-10): swapVehicle" "$FILE" || {
  echo "ABORT: swapVehicle sync clause missing from $FILE — edit not applied." >&2; exit 1; }
echo "Guard OK: swapVehicle status-sync clause present."

# ── ENV: no new env keys.
# ── ENV: no new env keys in THIS ship (.env.example is not in FILES[], so the
# tag carries HEAD's copy). Check against the .env.example the TAG will actually
# contain, not the working tree's — 2026-07-16 the tree also held the unshipped
# Advantage workstream's 11 ADVANTAGE_* keys, which fail-closed the check even
# though this tag doesn't ship them. Verified OK: 68/68 against HEAD's copy.
ENVBAK="$(mktemp)"; cp backend/.env.example "$ENVBAK"
git checkout HEAD -- backend/.env.example
bash scripts/env-diff-check.sh || { cp "$ENVBAK" backend/.env.example; echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }
cp "$ENVBAK" backend/.env.example   # restore other workstreams' edits

# ── REGRESSION TEST (added 2026-07-16, when Hector re-reported the bug live).
# DB-backed; PROVEN to fail without the 14-line fix with the exact reported
# symptom (actual 'ON_RENT' vs expected 'AVAILABLE') and pass with it. Also
# covers: a locked (IN_MAINTENANCE) old car is never force-freed, and an old car
# still CHECKED_OUT on another rental stays ON_RENT.
TESTFILE="backend/src/modules/reservations/swap-vehicle-status-sync.test.mjs"
[ -f "$TESTFILE" ] || { echo "ABORT: regression test $TESTFILE missing." >&2; exit 1; }

FILES=(
  "$FILE"
  "$TESTFILE"
  ".deploy-notes/2026-06-10-ship-swap-vehicle-status-sync.sh"
  "ops/.agent-patches/09-swap-vehicle-status-sync.patch"
)

# ── STAGE (idempotent) + SURGICAL package.json.
# backend/package.json carries FOUR unrelated uncommitted workstreams (kiosk,
# advantage, customers-phone, flexways). Stage HEAD's copy with ONLY our
# test:reservations line swapped in, then restore the working copy so the other
# workstreams keep their edits untouched.
git reset >/dev/null
SCRATCH="$(mktemp -d)"
cp backend/package.json "$SCRATCH/pkg-working.json"
git show HEAD:backend/package.json > "$SCRATCH/pkg-head.json"
RES_LINE="$(grep '"test:reservations"' "$SCRATCH/pkg-working.json")"
[ -n "$RES_LINE" ] || { echo "ABORT: no test:reservations line in the working package.json" >&2; exit 1; }
awk -v repl="$RES_LINE" '{ if ($0 ~ /"test:reservations"/) print repl; else print }' "$SCRATCH/pkg-head.json" > backend/package.json
git add backend/package.json
cp "$SCRATCH/pkg-working.json" backend/package.json

git add -A -- "${FILES[@]}"

# ── GATE: nothing from another workstream may ride along in this tag.
EXTRA_PKG="$(git diff --cached backend/package.json | grep -E '^[+-][^+-]' | grep -v 'test:reservations' || true)"
[ -z "$EXTRA_PKG" ] || { echo "ABORT: package.json staged beyond test:reservations:"; echo "$EXTRA_PKG"; git reset >/dev/null; exit 1; }
LEAK="$(git diff --cached --name-only | grep -E 'schema\.prisma|kiosk|advantage|migrations/' || true)"
[ -z "$LEAK" ] || { echo "ABORT: unrelated workstream files staged:"; echo "$LEAK"; git reset >/dev/null; exit 1; }
echo "Guard OK: staged diff is swap-fix-only."

echo; git diff --cached --stat; echo
echo "Review:  git diff --cached -- $FILE"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reservations): sync Vehicle.status for both cars on swap-vehicle

swapVehicle moved Reservation.vehicleId + RentalAgreement.vehicleId to the
replacement car but never called syncVehicleStatusForReservation, so the
swapped-out car stayed ON_RENT and the replacement stayed AVAILABLE until the
hourly drift sweep repaired both (live: swap 200 @2026-06-10T17:23:01Z ->
sweep freed KII873 / rented KHV165 @17:29:28Z; same pair signature @15:29Z
and 2026-06-08). Sync inside the swap transaction: reservation's new vehicle
-> ON_RENT, previous vehicleId released unless locked or still out on another
rental (beta.116 helper semantics). Distinct path from the updateReservation
fix (patch 06). No migrations; no money/gateway code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + clean boot (no MODULE_NOT_FOUND/TypeError) + /health 200."
echo "  smoke: swap the vehicle on a CHECKED_OUT reservation — the old car should flip"
echo "         to AVAILABLE and the new one to ON_RENT immediately (no drift-sweep WARN"
echo "         at the next hourly sweep)."
