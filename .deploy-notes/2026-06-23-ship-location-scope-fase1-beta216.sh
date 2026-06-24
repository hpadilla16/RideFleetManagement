#!/usr/bin/env bash
# v0.9.0-beta.216 — Location independence FASE 1: binding usuario↔location (asignar, sin enforcement).
#   bash .deploy-notes/2026-06-23-ship-location-scope-fase1-beta216.sh
#
# Backend + Frontend, **CON migración aditiva**. SIN cambio de comportamiento todavía
# (Fase 2 hace el enforcement). Plan: doc/location-independence-plan-2026-06-23.md.
#
# QUÉ: agrega `User.locationIds` (JSON array de Location ids) para poder asignar a cada
# usuario qué location(s) ve. Vacío/null = ve TODAS (sin restricción) → CERO regresión: los
# usuarios actuales siguen viendo todo. La restricción real (filtrado de listas) llega en Fase 2.
#
# CAMBIOS:
#   backend/prisma/schema.prisma                         + User.locationIds String?
#   backend/prisma/migrations/20260623_user_location_ids/migration.sql  (ALTER TABLE ADD COLUMN IF NOT EXISTS)
#   backend/src/modules/auth/auth.service.js             getSessionUser selecciona locationIds; buildSessionUser
#                                                        lo parsea → req.user.locationIds (array | null=all)
#   backend/src/modules/people/people.service.js         createPerson/updatePerson aceptan+VALIDAN locationIds
#                                                        (solo ids del tenant); mapper expone locationIds[];
#                                                        invalida la sesión cacheada al cambiar (para Fase 2)
#   frontend/src/app/people/page.js                      multi-select de Locations en el form de persona
#
# Verificado local: `npx prisma validate` ✅; node --check de auth/people ✅; esbuild parse del people page ✅.
#
# DEPLOY (BACKEND + FRONTEND + MIGRACIÓN):
#   git fetch --tags && git checkout v0.9.0-beta.216
#   docker compose -f docker-compose.prod.yml build backend frontend
#   # migración por el puerto de SESIÓN 5432 (NUNCA pgbouncer 6543):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend frontend
#   # Hard refresh después.
#
# SMOKE:
#   - People → edita un empleado → aparece la sección "Locations" con checkboxes de tus locations.
#   - Marca 1-2 → Save → reabre el empleado → quedan marcadas. Deja todo sin marcar = "All locations".
#   - (Fase 1 NO restringe lo que ve aún — eso es Fase 2.)
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260623_user_location_ids/migration.sql
#   backend/src/modules/auth/auth.service.js
#   backend/src/modules/people/people.service.js
#   frontend/src/app/people/page.js
#   doc/location-independence-plan-2026-06-23.md
#   .deploy-notes/2026-06-23-ship-location-scope-fase1-beta216.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.216"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260623_user_location_ids/migration.sql"
  "backend/src/modules/auth/auth.service.js"
  "backend/src/modules/people/people.service.js"
  "frontend/src/app/people/page.js"
  "doc/location-independence-plan-2026-06-23.md"
  ".deploy-notes/2026-06-23-ship-location-scope-fase1-beta216.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/auth/auth.service.js   || { echo "ABORT: node --check auth" >&2; exit 1; }
node --check backend/src/modules/people/people.service.js || { echo "ABORT: node --check people" >&2; exit 1; }
grep -q "locationIds" backend/prisma/schema.prisma || { echo "ABORT: falta el campo en schema" >&2; exit 1; }
grep -q 'ADD COLUMN IF NOT EXISTS "locationIds"' backend/prisma/migrations/20260623_user_location_ids/migration.sql || { echo "ABORT: migración mal" >&2; exit 1; }
grep -q "locationIds: parseLocationIds" backend/src/modules/auth/auth.service.js || { echo "ABORT: sesión no hidrata locationIds" >&2; exit 1; }
grep -q "normalizeLocationIds" backend/src/modules/people/people.service.js || { echo "ABORT: people no valida locationIds" >&2; exit 1; }
grep -q "section-title\">Locations" "frontend/src/app/people/page.js" || { echo "ABORT: falta el UI de Locations" >&2; exit 1; }
( cd backend && npx prisma validate >/dev/null 2>&1 ) || { echo "ABORT: prisma validate" >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(locations): Fase 1 — User.locationIds binding (assign users to locations)

Adds User.locationIds (JSON array; null/empty = ALL locations) so each user can be scoped
to specific locations. Session hydration exposes req.user.locationIds; people create/update
validate the ids against the tenant and invalidate the cached session on change; People UI
gets a Locations multi-select. NO enforcement yet (Fase 2) → zero behavior change / no
regression. Additive migration. Plan: doc/location-independence-plan-2026-06-23.md."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build → migrate deploy (5432) → force-recreate. Hard refresh."
