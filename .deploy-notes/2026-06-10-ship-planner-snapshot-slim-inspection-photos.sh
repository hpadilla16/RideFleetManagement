#!/usr/bin/env bash
# GET /api/planner/snapshot 504 / Prisma 57014 statement-timeout fix: stop
# loading multi-MB photosJson blobs in bulk vehicle-signal hydration.
#   bash .deploy-notes/2026-06-10-ship-planner-snapshot-slim-inspection-photos.sh
#
# NOT a money path. NO migration. Two files, both non-payment:
#   backend/src/modules/vehicles/vehicle-intelligence.service.js
#   backend/src/modules/vehicles/vehicle-intelligence.test.mjs (new unit tests)
#
# WHY (bug fleet-backend-prod__planner-snapshot-vehicle-signals-statement-timeout-504,
# Sentry JAVASCRIPT-NEXTJSBACKEND-17 + nginx 504 @2026-06-09T18:47:08Z + 53s
# 200 @2026-06-10T16:48:41Z, 2 distinct staff users in 2 days):
# buildVehicleOperationalSignalsMap hydrates the latest agreement per vehicle
# and SELECTs inspections WITH photosJson — multi-MB base64 per row, ~125
# latest agreements => prisma slow query 140939ms on the
# RentalAgreementInspection SELECT, then 57014 'canceling statement due to
# statement timeout'. The blob was only ever used for KEY PRESENCE (which of
# the 8 required photo slots exist). Same bomb sits under issue-center claims
# (bulk) — planner is just where staff hit it first.
#
# FIX (see ops/.agent-patches/10-planner-snapshot-slim-inspection-photos.patch):
#   1. Nested select photosJson -> photoStorageRefs (slim Json; rows written
#      since INSPECTION_PHOTOS_STORAGE_ENABLED=true carry per-slot keys).
#   2. Parallel cheap probe: pg_column_size("photosJson") > 64 (reads TOAST
#      header size, does NOT detoast the blob) to know whether a legacy row
#      has inline photos at all.
#   3. New slimInspectionPhotoMap(): refs -> exact per-key coverage (keys
#      canonicalized snake_case->camelCase via beta.151 normalizer); legacy
#      blob present -> coverage treated as COMPLETE (no false "missing photo"
#      attention); nothing -> 0 coverage (unchanged).
#
# TRADE-OFF FOR YOUR REVIEW (the one behavior change): legacy rows whose
# inline photo set is PARTIAL no longer raise "missing N required photo(s)"
# attention in planner/vehicle/issue-center signals — we don't open the blob
# to count keys. In exchange: planner snapshot stops timing out, and
# mobile-flow inspections (array-shape photosJson) stop reporting a FALSE
# 0/8 coverage (they never matched camelCase keys — pre-existing gap).
# Exact per-key coverage is back for every row written with storage refs
# (flag is ON in prod since 2026-06-10). Damage keywords / condition flags /
# telematics signals are untouched.
#
# Verified in sandbox @ HEAD e9359b3 (release/deposit-balance-fix-beta119):
# git apply --check CLEAN on a detached worktree of HEAD; node --check OK;
# vehicle-intelligence.test.mjs 9/9 pass (6 existing + 3 new for
# slimInspectionPhotoMap). Independent of staged patches 05-09 (different
# files/hunks) — ship in any order.
#
# NOTE: a stale .git/index.lock (0 bytes, 2026-06-10 18:52Z, from an
# interrupted agent run) may still exist — the guard below clears it.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${TAG:-SET-NEXT-BETA-TAG}"
PATCH="ops/.agent-patches/10-planner-snapshot-slim-inspection-photos.patch"
FILE="backend/src/modules/vehicles/vehicle-intelligence.service.js"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
[ "$TAG" != "SET-NEXT-BETA-TAG" ] || { echo "Set TAG=v0.9.0-beta.NNN (next free beta) before running." >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

# ── APPLY the staged patch (working tree ships clean; agent never left edits).
if git apply --check "$PATCH" 2>/dev/null; then
  git apply "$PATCH"; echo "Applied $PATCH."
elif grep -q "slimInspectionPhotoMap" "$FILE"; then
  echo "Patch already applied — continuing."
else
  echo "ABORT: $PATCH does not apply and the change is absent. Resolve manually." >&2; exit 1
fi

# ── SYNTAX GATE
( cd backend && node --check "src/modules/vehicles/vehicle-intelligence.service.js" )
echo "node --check OK."

# ── UNIT GATE: intelligence builders incl. the 3 new slim-coverage tests
node --test --test-force-exit backend/src/modules/vehicles/vehicle-intelligence.test.mjs >/dev/null \
  && echo "vehicle-intelligence tests OK." \
  || { echo "ABORT: vehicle-intelligence tests failed." >&2; exit 1; }

# ── GUARD: the blob must be GONE from the bulk hydration select
grep -nq "photosJson: true" "$FILE" && {
  echo "ABORT: photosJson still selected in $FILE — blob bomb not removed." >&2; exit 1; }
grep -nq "pg_column_size" "$FILE" || {
  echo "ABORT: pg_column_size presence probe missing from $FILE." >&2; exit 1; }
echo "Guard OK: slim hydration in place."

# ── ENV: no new env keys.
bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

FILES=(
  "$FILE"
  "backend/src/modules/vehicles/vehicle-intelligence.test.mjs"
  ".deploy-notes/2026-06-10-ship-planner-snapshot-slim-inspection-photos.sh"
  "ops/.agent-patches/10-planner-snapshot-slim-inspection-photos.patch"
)
git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "Review:  git diff --cached -- $FILE"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "perf(planner): stop loading photosJson blobs in bulk vehicle-signal hydration

buildVehicleOperationalSignalsMap selected photosJson (multi-MB base64 per
inspection row) for every latest agreement just to check which photo slots
exist — 140939ms RentalAgreementInspection SELECT, 57014 statement-timeout
cancel, GET /api/planner/snapshot 504/53s for 2 staff users in 2 days
(Sentry JAVASCRIPT-NEXTJSBACKEND-17). Coverage now derives from the slim
photoStorageRefs Json (exact keys, canonicalized via the beta.151 normalizer)
plus a pg_column_size() presence probe that never detoasts the blob; legacy
rows with inline photos count as complete instead of false-flagging missing
photos (mobile array-shape rows previously reported 0/8). No migration; no
money/gateway code. Unit tests: 9/9 incl. 3 new for slimInspectionPhotoMap."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + clean boot + /health 200."
echo "  smoke: open /planner (30-day window) as staff — snapshot should return in"
echo "         a few seconds, no 504; backend log free of 57014/statement-timeout."
echo "  watch: vehicle detail + issue-center still show inspection/turn-ready"
echo "         signals (coverage from refs on new rows, complete-if-present on legacy)."
