#!/usr/bin/env bash
# v0.9.0-beta.143 — Vehicle mileage history + manual adjust.
#   bash .deploy-notes/2026-06-09-ship-vehicle-mileage-history-beta143.sh
#
# ORDER: stacks ON TOP of beta.142 (orphan-loaner tenantId fix). Ship beta.142
# first; if beta.142 is already in the tree but not yet tagged, tag it before
# this so the beta numbers stay monotonic. No money/gateway code, no access
# control. ADDITIVE migration (one new table + enum).
#
# WHAT (reported by rental agents): the vehicle profile showed a single mileage
# number with no hint of where it came from, and there was no history of the
# check-in/check-out odometer inputs. Root cause: only CHECK-IN mirrored the
# odometer onto Vehicle.mileage — CHECK-OUT wrote odometerOut on the agreement
# but never touched the vehicle. Fix:
#   - New VehicleMileageEntry timeline; "last entry wins" mirrors the newest
#     reading onto Vehicle.mileage + lastOdometerSource.
#   - Check-OUT now logs a CHECKOUT entry (closes the gap), check-IN logs CHECKIN.
#   - Agents can correct mileage from the profile → logged as a MANUAL entry.
#   - Profile shows current mileage + its source/date, plus the full history.
#   - Backfill script seeds history from existing agreement odometers.
#
# FILES:
#   backend/prisma/schema.prisma                                  VehicleMileageEntry model + MileageEntrySource enum + back-relations
#   backend/prisma/migrations/20260609_vehicle_mileage_history/   ADD table + enum + FKs (additive, idempotent)
#   backend/src/modules/vehicles/mileage-history.service.js       recordMileageEntry / recordMileageEntrySafe ("last entry wins")
#   backend/src/modules/vehicles/vehicles.service.js              recordManualMileage + getById returns mileageHistory/lastMileageEntry
#   backend/src/modules/vehicles/vehicles.routes.js               POST /api/vehicles/:id/mileage (manual adjust)
#   backend/src/modules/rental-agreements/rental-agreements.service.js  checkout finalize logs CHECKOUT entry
#   backend/src/modules/rental-agreements/checkin-close.service.js      check-in logs CHECKIN entry (replaces inline Vehicle.update)
#   backend/scripts/backfill-mileage-history.mjs                  one-off backfill (run post-migrate)
#   frontend/src/app/vehicles/[id]/page.js                        mileage tile + Ajustar modal + Historial de Millaje table
#   .deploy-notes/2026-06-09-ship-vehicle-mileage-history-beta143.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.143"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH (must be at the beta.142 tip)"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260609_vehicle_mileage_history/migration.sql"
  "backend/src/modules/vehicles/mileage-history.service.js"
  "backend/src/modules/vehicles/mileage-history.service.test.mjs"
  "backend/src/modules/rental-agreements/rental-agreements-finalize-tx.test.mjs"
  "backend/src/modules/vehicles/vehicles.service.js"
  "backend/src/modules/vehicles/vehicles.routes.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/rental-agreements/checkin-close.service.js"
  "backend/scripts/backfill-mileage-history.mjs"
  "frontend/src/app/vehicles/[id]/page.js"
  ".deploy-notes/2026-06-09-ship-vehicle-mileage-history-beta143.sh"
)

# ── SYNTAX GATE: backend via node --check; frontend (jsx) validated by the
#    docker build (force-recreate below).
( cd backend \
  && node --check src/modules/vehicles/mileage-history.service.js \
  && node --check src/modules/vehicles/vehicles.service.js \
  && node --check src/modules/vehicles/vehicles.routes.js \
  && node --check src/modules/rental-agreements/rental-agreements.service.js \
  && node --check src/modules/rental-agreements/checkin-close.service.js \
  && node --check scripts/backfill-mileage-history.mjs )
echo "node --check OK."

# ── UNIT TESTS: the mileage helper (no DB) + the finalize-tx op-order contract.
( cd backend && node --test src/modules/vehicles/mileage-history.service.test.mjs ) \
  && echo "mileage-history unit tests OK."

# ── PRISMA: schema must validate (catches a bad model/relation before migrate).
( cd backend && npx prisma validate >/dev/null ) && echo "prisma validate OK."

# ── GUARDS: confirm the wiring is present end-to-end.
grep -nq "model VehicleMileageEntry" backend/prisma/schema.prisma || { echo "ABORT: schema missing VehicleMileageEntry." >&2; exit 1; }
grep -nq "VehicleMileageEntry" backend/prisma/migrations/20260609_vehicle_mileage_history/migration.sql || { echo "ABORT: migration missing table." >&2; exit 1; }
grep -nq "recordMileageEntry" backend/src/modules/vehicles/mileage-history.service.js || { echo "ABORT: helper missing." >&2; exit 1; }
grep -nq "recordManualMileage" backend/src/modules/vehicles/vehicles.service.js || { echo "ABORT: service missing recordManualMileage." >&2; exit 1; }
grep -nq "/:id/mileage" backend/src/modules/vehicles/vehicles.routes.js || { echo "ABORT: manual mileage route missing." >&2; exit 1; }
grep -nq "source: 'CHECKOUT'" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: checkout not logging CHECKOUT entry." >&2; exit 1; }
grep -nq "source: 'CHECKIN'" backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: checkin not logging CHECKIN entry." >&2; exit 1; }
grep -nq "Historial de Millaje" "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: profile missing mileage history UI." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "Review:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(vehicles): per-vehicle mileage history + manual adjust

Rental agents had no way to tell where a vehicle's mileage came from or to see
the history of check-in/check-out odometer inputs. Root cause: only check-in
mirrored the odometer onto Vehicle.mileage; check-out wrote odometerOut on the
agreement but never touched the vehicle.

- schema: VehicleMileageEntry model + MileageEntrySource enum (additive migration).
- mileage-history.service: recordMileageEntry ('last entry wins' → Vehicle.mileage
  + lastOdometerSource) + recordMileageEntrySafe.
- checkout finalize: logs a CHECKOUT entry in the same tx (closes the gap).
- checkin close: logs a CHECKIN entry (replaces the inline Vehicle.update).
- POST /api/vehicles/:id/mileage: manual correction → MANUAL entry, tenant-scoped.
- getById: returns mileageHistory (latest 25) + lastMileageEntry.
- vehicle profile: mileage tile shows source/date, Ajustar modal, history table.
- backfill-mileage-history.mjs: seeds history from existing agreement odometers.
No money/gateway code, no access control. Additive migration only."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "  # MIGRATION (additive) — run via the SESSION port 5432, never pgbouncer 6543:"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); npx prisma migrate deploy'"
echo
echo "  # BACKFILL (after migrate) — dry run first, then --apply:"
echo "  docker exec fleet-backend-prod sh -c 'cd /app/backend 2>/dev/null || cd /app; node scripts/backfill-mileage-history.mjs'"
echo "  docker exec fleet-backend-prod sh -c 'cd /app/backend 2>/dev/null || cd /app; node scripts/backfill-mileage-history.mjs --apply'"
echo
echo "VERIFY: 4 containers healthy + clean boot (no MODULE_NOT_FOUND/TypeError) + /health 200 + frontend HARD refresh."
echo "  smoke: open a vehicle profile → 'Historial de Millaje' table + mileage tile shows source/date."
echo "         Ajustar millaje → save → new MANUAL row on top, tile updates."
echo "         Do a check-out then a check-in → each appends its CHECKOUT/CHECKIN row."
