#!/usr/bin/env bash
# v0.9.0-beta.218 — Location independence FASE 2c: enforcement en Dashboard KPIs + Maintenance.
#   bash .deploy-notes/2026-06-23-ship-location-scope-fase2c-beta218.sh
#
# Backend-only, SIN migración. Cierra el enforcement de visibilidad para los AGREGADOS.
# DEPENDE de 216 (User.locationIds + sesión) y 217 (scope.allowedLocationIds). Stackea encima.
#
# QUÉ: un usuario scopeado a ciertas locations ahora también ve los KPIs/agregados SOLO de esas
# locations (antes el dashboard mostraba totales del tenant). Patrón: set efectivo de location
# = (scope.allowedLocationIds ∩ selección del usuario); admins/sin restricción → sin filtro.
#   - reports.service `overview` (KPIs del Dashboard): los ~11 filtros inline `locationId` pasaron
#     a un set efectivo `{ in: effLocIds }` (pickupLocationId / homeLocationId).
#   - reports.service `servicesSold` (reporte de comisiones por service): mismo filtro.
#   - maintenance.service `summary` (Repair Orders + fleet down): roWhere(locationId) y fleetWhere
#     (homeLocationId) pasan al set efectivo.
#   - planner.service `loadPlannerReservations` + `loadPlannerVehicles`: el set efectivo restringe
#     el snapshot del Planner (reservas por pickup/return/vehicle-home; vehículos por homeLocationId).
#
# CON ESTO el location-scope queda COMPLETO (listas + por-id + KPIs + maintenance + planner).
# NOTA menor: maintenance `board`/`due` usan tenantWhere; el `summary` (los KPIs) ya filtra —
# board/due se pueden extender igual si se quiere granularidad total (no crítico).
#
# Verificado local: node --check (reports + maintenance) ✅; 0 patrones inline sin convertir ✅;
# test tenant-scope 8/8 ✅.
#
# DEPLOY (BACKEND ONLY):
#   git fetch --tags && git checkout v0.9.0-beta.218
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend
#   # (Migración de 216 si aún no corrió — va incluida en el checkout.)
#
# SMOKE: como un OPS con 1 location asignada → el Dashboard muestra KPIs SOLO de esa location;
#   admin sigue viendo los totales del tenant.
#
# FILES:
#   backend/src/modules/reports/reports.service.js
#   backend/src/modules/maintenance/maintenance.service.js
#   .deploy-notes/2026-06-23-ship-location-scope-fase2c-beta218.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.218"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reports/reports.service.js"
  "backend/src/modules/maintenance/maintenance.service.js"
  "backend/src/modules/planner/planner.service.js"
  ".deploy-notes/2026-06-23-ship-location-scope-fase2c-beta218.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/reports/reports.service.js || { echo "ABORT: node --check reports" >&2; exit 1; }
node --check backend/src/modules/maintenance/maintenance.service.js || { echo "ABORT: node --check maintenance" >&2; exit 1; }
# No deben quedar filtros inline single-location sin convertir en los métodos tocados:
[ "$(grep -cF 'locationId ? { pickupLocationId: locationId }' backend/src/modules/reports/reports.service.js)" = "0" ] || { echo "ABORT: quedan filtros pickup inline" >&2; exit 1; }
[ "$(grep -cF 'locationId ? { homeLocationId: locationId }' backend/src/modules/reports/reports.service.js)" = "0" ] || { echo "ABORT: quedan filtros home inline" >&2; exit 1; }
grep -q "allowedLocationIds" backend/src/modules/maintenance/maintenance.service.js || { echo "ABORT: maintenance no aplica el scope" >&2; exit 1; }
node --check backend/src/modules/planner/planner.service.js || { echo "ABORT: node --check planner" >&2; exit 1; }
grep -q "allowedLocationIds" backend/src/modules/planner/planner.service.js || { echo "ABORT: planner no aplica el scope" >&2; exit 1; }
# exit code de node --test = la verificación (el reporter varía '# fail 0' vs 'ℹ fail 0').
( cd backend && node --test --test-force-exit src/modules/planner/planner.service.test.mjs >/tmp/pl.out 2>&1 ) || { echo "ABORT: planner tests fallaron:" >&2; tail -10 /tmp/pl.out >&2; exit 1; }
echo "Guards OK (planner verde)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(locations): Fase 2c — enforce location scope on Dashboard KPIs + Maintenance + Planner

A scoped user's Dashboard KPIs, Maintenance summary and Planner snapshot now reflect only
their allowed locations (effective set = scope.allowedLocationIds ∩ selection; admins/
unrestricted = no filter). reports.service overview + servicesSold convert the ~11 inline
single-location filters to { in: effLocIds }; maintenance.service summary filters roWhere
(RepairOrder.locationId) + fleetWhere (homeLocationId); planner.service loadPlannerReservations
+ loadPlannerVehicles restrict the snapshot. Completes location-scope (lists + by-id + KPIs +
maintenance + planner). Backend-only; depends on beta.216/217. Planner tests 2/2."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → force-recreate."
