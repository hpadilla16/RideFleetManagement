#!/usr/bin/env bash
# Program Visibility por empleado (Fases A+B): Rental only / Loaner only / Both.
#   bash .deploy-notes/2026-07-02-ship-program-scope-AB.sh
#   (tag default v0.9.0-beta.279 — override: TAG_OVERRIDE=v0.9.0-beta.NNN)
#
# BACKEND + FRONTEND, CON MIGRACIÓN ADITIVA (20260702_user_program_scope, por 5432).
# Pipeline completo: Plan → build → Innovation (3 MUST leaks corregidos) + Graphic Design
# (mockup aprobado por Hector: doc/program-scope-mockups-2026-07-02.html) → QA = SHIP
# (192 tests verdes, 0 BLOCKER/MAJOR).
#
# QUÉ (spec Hector 2026-07-02): el admin define por EMPLEADO qué programa ve:
#   - User.programScope enum RENTAL_ONLY | LOANER_ONLY | BOTH (default BOTH = cero regresión).
#   - LOANER_ONLY: mismos módulos, data filtrada — reservas solo workflowMode DEALERSHIP_LOANER,
#     vehículos solo programCategory LOANER_ONLY/BOTH, agreements vía la relación reservation,
#     dashboard/KPIs/planner/reports/employee-app filtrados igual.
#   - RENTAL_ONLY: solo data rental (car-sharing cuenta como rental, decisión Hector) y ADEMÁS
#     pierde el módulo loaner completo (clamp en module-access → nav + rutas 403 solos).
#   - ADMIN/SUPER_ADMIN/BOTH: sin cambio alguno (bypass, fragmentos = no-op).
#   - COMPONE con el location scoping (ambos filtros a la vez).
#   - UI: radio de 3 pills "Program Visibility" en People (deshabilitado para admins con hint).
#
# EXTRAS que van en este ship (hallazgos de la revisión):
#   - Cache keys de /reservations (summary/list/page) ahora llevan el segmento de visibilidad
#     (programScope + locations) — cerraba un cache-poisoning entre usuarios scoped y admins
#     que YA existía para location scoping.
#   - customers.getById: el historial embebido (reservas + agreements) se filtra por programa.
#   - Reports v1 (contractsExcel, vehicleRevenue±Excel, inventoryReport±Excel, servicesSold)
#     scoped; reports-v2 devuelve 403 claro a cuentas program-scoped (threading = Fase C,
#     TODO fechado en reports-v2.routes.js).
#   - /:id/available-vehicles filtra candidatos por programa.
#   - Fix de paso: el filtro workflowMode 'STANDARD_RENTAL' del reservations report nunca
#     matcheaba (el enum es RENTAL) — ahora se mapea el alias.
#   - PLANNER + LOCATION (aprobado por Hector): planner.routes ahora inyecta allowedLocationIds
#     → se ACTIVAN los filtros de location Fase 2c que estaban dormidos. CAMBIO VISIBLE para
#     empleados restringidos por location: su planner ahora muestra solo su(s) location(s).
#
# GAPS ACEPTADOS (Fase C, documentados — no mueven dinero ni corrompen estado):
#   write-paths sin guard simétrico (la UI no los expone) · checkout-session by-ID sin scope de
#   programa · long-term plans list sin filtrar · inventory/maintenance/tolls/citations/issue-center
#   tenant-wide para scoped users · reports-v2 403 en vez de data filtrada.
#
# ── SMOKE (crear un usuario OPS de prueba) ──
#   1) People → editar empleado → Program Visibility = "Loaner only" → login como él:
#      Reservations solo muestra loaners, Vehicles solo los 14 LOANER_ONLY + BOTH, dashboard
#      KPIs solo loaner, reports-v2 → 403, customer detail sin historial rental.
#   2) Cambiarlo a "Rental only": desaparece el nav de Loaner, /api/dealership-loaner → 403,
#      cero filas DEALERSHIP_LOANER en reservations.
#   3) Volver a "Both": todo como antes. Admin: sin cambios en todo momento.
#   4) Empleado con location restringida: el planner ahora muestra solo su location (nuevo).
#
# DEPLOY (BACKEND + FRONTEND + MIGRACIÓN):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   # migración por el puerto de SESIÓN (nunca 6543):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   (el build regenera el Prisma client; en dev local: npx prisma generate tras el pull)
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260702_user_program_scope/migration.sql
#   backend/src/lib/tenant-scope.js
#   backend/src/lib/tenant-scope.test.mjs
#   backend/src/lib/program-category.js
#   backend/src/lib/program-category.test.mjs
#   backend/src/lib/module-access.js
#   backend/src/modules/auth/auth.service.js
#   backend/src/modules/vehicles/vehicles.service.js
#   backend/src/modules/reservations/reservations.service.js
#   backend/src/modules/reservations/reservations.routes.js
#   backend/src/modules/reservations/reservation-summary-counters.service.js
#   backend/src/modules/rental-agreements/rental-agreements.service.js
#   backend/src/modules/reports/reports.service.js
#   backend/src/modules/reports/reports-v2.routes.js
#   backend/src/modules/customers/customers.service.js
#   backend/src/modules/planner/planner.service.js
#   backend/src/modules/planner/planner.routes.js
#   backend/src/modules/employee-app/employee-app.service.js
#   backend/src/modules/people/people.service.js
#   backend/package.json
#   frontend/src/app/people/page.js
#   frontend/src/app/globals.css
#   doc/program-scope-mockups-2026-07-02.html
#   .deploy-notes/2026-07-02-ship-program-scope-AB.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.279}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260702_user_program_scope/migration.sql"
  "backend/src/lib/tenant-scope.js"
  "backend/src/lib/tenant-scope.test.mjs"
  "backend/src/lib/program-category.js"
  "backend/src/lib/program-category.test.mjs"
  "backend/src/lib/module-access.js"
  "backend/src/modules/auth/auth.service.js"
  "backend/src/modules/vehicles/vehicles.service.js"
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/src/modules/reservations/reservation-summary-counters.service.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/reports/reports.service.js"
  "backend/src/modules/reports/reports-v2.routes.js"
  "backend/src/modules/customers/customers.service.js"
  "backend/src/modules/planner/planner.service.js"
  "backend/src/modules/planner/planner.routes.js"
  "backend/src/modules/employee-app/employee-app.service.js"
  "backend/src/modules/people/people.service.js"
  "backend/package.json"
  "frontend/src/app/people/page.js"
  "frontend/src/app/globals.css"
  "doc/program-scope-mockups-2026-07-02.html"
  ".deploy-notes/2026-07-02-ship-program-scope-AB.sh"
)

# ── SANITY GATES ──
for f in "${FILES[@]}"; do case "$f" in backend/src/*.js) node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; };; esac; done
grep -q "programScope" backend/prisma/schema.prisma || { echo "ABORT: schema sin programScope" >&2; exit 1; }
grep -q "IF NOT EXISTS" backend/prisma/migrations/20260702_user_program_scope/migration.sql || { echo "ABORT: migración no idempotente" >&2; exit 1; }
grep -q "scopeVisibilityCacheSegment" backend/src/modules/reservations/reservations.routes.js || { echo "ABORT: cache keys sin segmento de visibilidad" >&2; exit 1; }
grep -q "rejectProgramScopedUsers" backend/src/modules/reports/reports-v2.routes.js || { echo "ABORT: reports-v2 sin guard" >&2; exit 1; }
grep -q "allowedLocationIds: userAllowedLocationIds" backend/src/modules/planner/planner.routes.js || { echo "ABORT: planner sin location injection aprobada" >&2; exit 1; }
( cd backend && npx prisma validate && npm run lint:cache-keys && npm run test:scope && npm run test:cache && npm run test:booking-engine && npm run test:planner && npm run test:loaner && npm run test:people && npm run test:auth ) || { echo "ABORT: gates fallaron" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(people): per-employee program visibility — rental only / loaner only / both

User.programScope (additive migration, default BOTH) lets admins scope what an
employee sees in EVERY module: LOANER_ONLY keeps all modules but only loaner
data (reservations workflowMode DEALERSHIP_LOANER, vehicles LOANER_ONLY/BOTH,
agreements via the reservation relation, dashboards/planner/reports/employee-app
filtered); RENTAL_ONLY sees only rental-side data (car-sharing included) and
loses the loaner module via a module-access clamp. Composes with location
scoping; ADMIN/SUPER_ADMIN and BOTH users are byte-identical no-ops. Review
hardening shipped along: reservations cache keys now carry a visibility segment
(fixes pre-existing scoped-vs-admin cache poisoning), customer detail history is
program-filtered, reports v1 exports scoped + reports-v2 fail-closed 403 for
scoped accounts (Fase C threading TODO), available-vehicles candidates filtered,
STANDARD_RENTAL alias fix, and the dormant Fase 2c planner location filters are
now ACTIVE (Hector-approved). People page gets a 3-pill Program Visibility
control (disabled for admins). Full pipeline: Innovation + Graphic Design +
QA SHIP, 192 tests green."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"
echo "Pushed $TAG. Droplet: build backend+frontend → recreate backend worker frontend → MIGRACIÓN por 5432 → smoke con usuario OPS de prueba."
