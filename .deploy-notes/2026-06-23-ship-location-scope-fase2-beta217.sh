#!/usr/bin/env bash
# v0.9.0-beta.217 — Location independence FASE 2 (core): enforcement de visibilidad.
#   bash .deploy-notes/2026-06-23-ship-location-scope-fase2-beta217.sh
#
# Backend-only, SIN migración propia. **CAMBIA COMPORTAMIENTO**: un usuario con locations
# asignadas (Fase 1) ahora SOLO ve la flota y reservas de esas locations. Admins ven todo.
# DEPENDE de beta.216 (User.locationIds + sesión). Stackea sobre 216.
#
# QUÉ (core de Fase 2 — las 2 listas de mayor valor):
#   - `userAllowedLocationIds(user)` en tenant-scope.js → array | null(=todas). SUPER_ADMIN/ADMIN
#     siempre null (bypass); locationIds vacío = null. Se inyecta en el scope (resolveTenantScopedUser).
#   - **Vehicles** (`vehicles.service.list`) → filtra por `homeLocationId in allowed`.
#   - **Reservations** (`listPage` + `list`) → filtra por `pickupLocationId OR returnLocationId in allowed`
#     (compuesto con AND para no romper los OR de search/overdue).
#   - **Guardas por-id** (Fase 2b incluida aquí): Vehicles.getById y Reservations.getById agregan el
#     mismo filtro de location → un user scopeado que abra por URL un vehículo/reserva fuera de su
#     location recibe null → 404. (Cierra el hueco de acceso directo por id.)
#   - Test `tenant-scope.test.mjs` (8/8) del helper.
#
# PENDIENTE Fase 2c (NO en este ship — agregados/complejos, se hace aparte con cuidado):
#   Planner, Maintenance/Repair Orders, Dashboard KPIs. Hoy un user scopeado ve sus listas + detalles
#   filtrados y bloqueados por id, pero el dashboard muestra totales del tenant (números, no data
#   accionable). Se cierra en 2c.
#
# Verificado local: node --check (tenant-scope/vehicles/reservations) ✅; test 8/8 (--test-force-exit) ✅.
#
# DEPLOY (BACKEND ONLY):
#   git fetch --tags && git checkout v0.9.0-beta.217
#   # Si 216 aún no se deployó, su migración va incluida en este checkout — córrela:
#   #   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend
#
# SMOKE:
#   1. Crea/usa un OPS con 1 location asignada (Fase 1) → entra como ese user → Vehicles y
#      Reservations muestran SOLO esa location. Otro user sin restricción (o admin) ve todo.
#   2. Confirma que NADA cambió para admins (siguen viendo todo).
#
# FILES:
#   backend/src/lib/tenant-scope.js
#   backend/src/lib/tenant-scope.test.mjs
#   backend/src/modules/vehicles/vehicles.service.js
#   backend/src/modules/reservations/reservations.service.js
#   .deploy-notes/2026-06-23-ship-location-scope-fase2-beta217.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.217"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/lib/tenant-scope.js"
  "backend/src/lib/tenant-scope.test.mjs"
  "backend/src/modules/vehicles/vehicles.service.js"
  "backend/src/modules/reservations/reservations.service.js"
  ".deploy-notes/2026-06-23-ship-location-scope-fase2-beta217.sh"
)

# ── SANITY GATES ── (OJO macOS: NO usar `timeout` — no existe en el Mac de Hector)
node --check backend/src/lib/tenant-scope.js || { echo "ABORT: node --check tenant-scope" >&2; exit 1; }
node --check backend/src/modules/vehicles/vehicles.service.js || { echo "ABORT: node --check vehicles" >&2; exit 1; }
node --check backend/src/modules/reservations/reservations.service.js || { echo "ABORT: node --check reservations" >&2; exit 1; }
grep -q "export function userAllowedLocationIds" backend/src/lib/tenant-scope.js || { echo "ABORT: falta el helper" >&2; exit 1; }
grep -q "allowedLocationIds" backend/src/modules/vehicles/vehicles.service.js || { echo "ABORT: vehicles no filtra" >&2; exit 1; }
grep -q "allowedLocationIds" backend/src/modules/reservations/reservations.service.js || { echo "ABORT: reservations no filtra" >&2; exit 1; }
# node --test sale con código != 0 si algún test falla → el exit code ES la verificación
# (no grepear el output: el reporter varía '# fail 0' vs 'ℹ fail 0' entre versiones de node).
( cd backend && node --test --test-force-exit src/lib/tenant-scope.test.mjs >/tmp/loc-test.out 2>&1 ) || { echo "ABORT: tests fallaron:" >&2; tail -15 /tmp/loc-test.out >&2; exit 1; }
echo "Guards OK (tests verde)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(locations): Fase 2 — enforce location scope on Vehicles + Reservations (lists + by-id)

userAllowedLocationIds(user) (null=all; SUPER_ADMIN/ADMIN bypass; empty=all) is injected
into the request scope. Vehicles list filters by homeLocationId; Reservations listPage+list
filter by pickup OR return location (ANDed so search/overdue ORs still work). getById on both
adds the same filter so a scoped user can't open an out-of-location record by URL (→ 404).
A user assigned to certain locations only sees/accesses that fleet + those bookings; admins
see everything. Planner/Maintenance/Dashboard KPIs are Fase 2c. Backend-only; depends on
beta.216. Test tenant-scope.test.mjs 8/8."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → force-recreate. (Migración de 216 si falta.)"
