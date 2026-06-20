#!/usr/bin/env bash
# v0.9.0-beta.206 — Maintenance Module Fases 1+2 (schema + backend API). El frontend va aparte.
#   bash .deploy-notes/2026-06-19-ship-maintenance-module-backend-beta206.sh
#
# Backend-only, CON migración aditiva. Plan: doc/maintenance-module-plan-2026-06-18.md.
# ZERO charge logic: los costos del RO son registro INTERNO; no cobran a agreements/claims.
#
# QUE ENTRA:
#   1) Schema + migración aditiva: RepairOrder (numerado por unidad) + RepairOrderLine +
#      ServiceSchedule + enums (RepairOrderStatus/Source/LineType, ServiceType) + link
#      VehicleDamageReport.repairOrderId + RepairOrder.incidentId. (MaintenanceJob queda; se
#      migran sus filas en Fase 4.)
#   2) Backend /api/repair-orders: list/get/create (roNumber secuencial por vehículo, retry en la
#      carrera del unique) · patch · add/delete líneas · complete (→ daños vinculados a FIXED) ·
#      cancel (des-vincula daños) · from-damage (roll-up) · vehicle/:id (historial). Totales
#      derivados de las líneas (subtotal/tax/total).
#   3) Backend /api/maintenance: summary (KPIs por location: open ROs, due/overdue, vehicles down,
#      fleet down %, cost MTD), board (work items), due (service intervals due/overdue calculados
#      EN VIVO desde el odómetro + último servicio), y CRUD de service-schedules por vehículo.
#   4) Montado en main.js detrás de requireAuth + requireModuleAccess('vehicles'). OpenAPI actualizado.
#
# PENDIENTE (próximos pushes): Fase 3 frontend (Maintenance Hub + RO editor + Due + sección perfil);
# Fase 4 wire-up (Vehicle.status IN_MAINTENANCE al abrir RO + tile dashboard + migrar MaintenanceJob).
#
# Verificado: prisma validate OK; node --check OK (servicios + routes + main.js + docs); cliente
# generado (repairOrder/repairOrderLine/serviceSchedule presentes); smoke de `due` (OVERDUE/SOON/
# excluido correctos contra el odómetro).
#
# Deploy: build BACKEND + force-recreate + MIGRACIÓN (additive, 5432). Sin frontend.
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260619_maintenance_module/migration.sql
#   backend/src/modules/maintenance/repair-orders.service.js
#   backend/src/modules/maintenance/maintenance.service.js
#   backend/src/modules/maintenance/maintenance.routes.js
#   backend/src/main.js
#   backend/src/docs/extra-routes.generated.js
#   .deploy-notes/2026-06-19-ship-maintenance-module-backend-beta206.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.206"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260619_maintenance_module/migration.sql"
  "backend/src/modules/maintenance/repair-orders.service.js"
  "backend/src/modules/maintenance/maintenance.service.js"
  "backend/src/modules/maintenance/maintenance.routes.js"
  "backend/src/main.js"
  "backend/src/docs/extra-routes.generated.js"
  ".deploy-notes/2026-06-19-ship-maintenance-module-backend-beta206.sh"
)

# ── BOOT-SAFETY GATES (main.js importa el módulo nuevo → debe existir y estar en FILES[]) ──
for must in \
  "backend/src/modules/maintenance/maintenance.routes.js" \
  "backend/src/modules/maintenance/repair-orders.service.js" \
  "backend/src/modules/maintenance/maintenance.service.js" \
  "backend/prisma/migrations/20260619_maintenance_module/migration.sql"; do
  [ -f "$must" ] || { echo "ABORT: falta $must" >&2; exit 1; }
  printf '%s\n' "${FILES[@]}" | grep -Fqx "$must" || { echo "ABORT: $must no está en FILES[]." >&2; exit 1; }
done
for f in \
  backend/src/modules/maintenance/repair-orders.service.js \
  backend/src/modules/maintenance/maintenance.service.js \
  backend/src/modules/maintenance/maintenance.routes.js \
  backend/src/main.js \
  backend/src/docs/extra-routes.generated.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
grep -q "RepairOrder" backend/prisma/schema.prisma || { echo "ABORT: schema sin RepairOrder." >&2; exit 1; }
grep -q "RepairOrder" backend/prisma/migrations/20260619_maintenance_module/migration.sql || { echo "ABORT: migración sin RepairOrder." >&2; exit 1; }
grep -q "app.use('/api/repair-orders'" backend/src/main.js || { echo "ABORT: main.js no monta repair-orders." >&2; exit 1; }
grep -q "app.use('/api/maintenance'" backend/src/main.js || { echo "ABORT: main.js no monta maintenance." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(maintenance): Maintenance Module Fases 1+2 (schema + backend API)

Central fleet-care hub. New RepairOrder (per-unit numbered) + RepairOrderLine +
ServiceSchedule + enums; VehicleDamageReport.repairOrderId / RepairOrder.incidentId
links. /api/repair-orders (CRUD, lines, complete → grouped damages FIXED, cancel,
from-damage roll-up, vehicle history) and /api/maintenance (summary KPIs by location,
board, due — service intervals computed live from the odometer; service-schedule CRUD).
Mounted behind requireModuleAccess('vehicles'). RO costs are an internal record only —
no auto-charge. MaintenanceJob untouched (rows migrate in Fase 4). Additive migration.
Frontend (Hub/editor/Due/profile) and Vehicle.status wire-up come next."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend → force-recreate → MIGRAR (5432, no pgbouncer)."
