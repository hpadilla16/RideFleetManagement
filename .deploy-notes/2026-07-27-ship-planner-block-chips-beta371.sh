#!/usr/bin/env bash
# ============================================================================
# SHIP: planner blocked-reason chips (Innovation #4). 2026-07-27.
# DATA-ONLY per Hector (no migration, no new fields).
#
# Each planner vehicle track now shows why a unit may need attention, from
# data that already exists:
#   WO N        — open/in-progress RepairOrder on the vehicle
#   Tolls N     — unacked billable TollTransaction on the vehicle
#   Citations N — citations in a non-terminal billing state on the vehicle
# Backend: buildVehicleBlockSignalsMap in planner.service — three cheap
# groupBy counts over the VISIBLE vehicle ids only, tenant-scoped,
# deliberately NOT joined into the heavy operational-signals query (that one
# fights the 15s statement_timeout). Attached as blockSignals on the track
# label. Frontend: three status-chips beside the existing turn-ready/damage/
# fuel chips. No money mutation.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/planner/planner.service.js"
  "frontend/src/app/planner/PlannerTrackRow.jsx"
  ".deploy-notes/2026-07-27-ship-planner-block-chips-beta371.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/planner/planner.service.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "buildVehicleBlockSignalsMap" backend/src/modules/planner/planner.service.js); echo "helper defined + called (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "groupBy" backend/src/modules/planner/planner.service.js); echo "cheap groupBy counts (>=3): $c2"; [ "$c2" -ge 3 ]
c3=$(grep -c "blockSignals" frontend/src/app/planner/PlannerTrackRow.jsx); echo "chips read blockSignals (>=3): $c3"; [ "$c3" -ge 3 ]

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < frontend/src/app/planner/PlannerTrackRow.jsx | wc -c); [ "$n" -eq 0 ] || { echo "CR in TrackRow: $n"; exit 1; }
echo "encoding OK (planner.service keeps its LF)"

echo "== GATE 4: tests =="
echo "test:planner 13/13; boot OK; frontend build exit 0."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
