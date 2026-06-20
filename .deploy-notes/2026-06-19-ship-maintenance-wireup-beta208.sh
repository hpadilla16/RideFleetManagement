#!/usr/bin/env bash
# v0.9.0-beta.208 — Maintenance Module Fase 4 (wire-up): Vehicle.status + migración MaintenanceJob.
#   bash .deploy-notes/2026-06-19-ship-maintenance-wireup-beta208.sh
#
# Backend-only, SIN migración de schema. ZERO charge logic.
#
# QUE ENTRA:
#   1) Vehicle.status wire-up en repair-orders.service:
#      - Abrir un RO → Vehicle.status IN_MAINTENANCE, SOLO desde AVAILABLE/RESERVED (nunca yanka un
#        carro ON_RENT, nunca pisa SOLD/OUT_OF_SERVICE — son locked states del vehicle-status-sync).
#      - Completar/cancelar el ÚLTIMO RO abierto del carro → vuelve a AVAILABLE (el sweep horario
#        reconcilia a RESERVED/ON_RENT si aplica). Si quedan otros ROs abiertos, se mantiene.
#   2) scripts/backfill-maintenancejob-to-repairorder.mjs: migra las filas viejas de MaintenanceJob →
#      RepairOrder (source=MANUAL, una línea OTHER con el costo). Idempotente (marker [mj:<id>] en
#      notes). Dry-run por defecto; --apply para escribir. History-only (NO toca Vehicle.status).
#
# PENDIENTE (frontend, último push del módulo): sección "Maintenance history" en el perfil del
# vehículo + botón "Roll into RO" desde el Damage History + tile "Maintenance due / Fleet down" en
# el dashboard.
#
# Verificado: node --check OK; smoke del wireup (create→IN_MAINTENANCE, complete→AVAILABLE).
#
# Deploy: build BACKEND + force-recreate. SIN migración de schema.
# POST-DEPLOY (manual, opcional): correr el backfill dry-run y luego --apply:
#   docker exec fleet-backend-prod node scripts/backfill-maintenancejob-to-repairorder.mjs
#   docker exec fleet-backend-prod node scripts/backfill-maintenancejob-to-repairorder.mjs --apply
#
# FILES:
#   backend/src/modules/maintenance/repair-orders.service.js
#   backend/scripts/backfill-maintenancejob-to-repairorder.mjs
#   .deploy-notes/2026-06-19-ship-maintenance-wireup-beta208.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.208"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/maintenance/repair-orders.service.js"
  "backend/scripts/backfill-maintenancejob-to-repairorder.mjs"
  ".deploy-notes/2026-06-19-ship-maintenance-wireup-beta208.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/maintenance/repair-orders.service.js || { echo "ABORT: node --check service" >&2; exit 1; }
node --check backend/scripts/backfill-maintenancejob-to-repairorder.mjs || { echo "ABORT: node --check backfill" >&2; exit 1; }
grep -q "setVehicleInMaintenance" backend/src/modules/maintenance/repair-orders.service.js || { echo "ABORT: falta el wireup de status." >&2; exit 1; }
grep -q "clearVehicleMaintenanceIfDone" backend/src/modules/maintenance/repair-orders.service.js || { echo "ABORT: falta el clear de status." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(maintenance): Fase 4 wire-up — Vehicle.status + MaintenanceJob migration

Opening a repair order moves the vehicle to IN_MAINTENANCE (only from AVAILABLE/RESERVED;
never off an active rental, never over a locked SOLD/OUT_OF_SERVICE state). Completing or
cancelling the last open RO returns it to AVAILABLE and lets the hourly sweep reconcile.
New backfill script migrates legacy MaintenanceJob rows into RepairOrder (source=MANUAL,
one OTHER line for the cost; idempotent via a [mj:<id>] marker; dry-run unless --apply,
history-only). Remaining: vehicle-profile maintenance history + dashboard tile (frontend).
No schema migration; no charge logic."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend → force-recreate. Backfill manual opcional post-deploy."
