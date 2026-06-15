#!/usr/bin/env bash
# v0.9.0-beta.173 — Vehicles list cap: subir take 500→2000 + limit explícito en el frontend
#   bash .deploy-notes/2026-06-15-ship-vehicles-list-cap-beta173.sh
#
# BACKEND (vehicles.service.js) + FRONTEND (3 archivos). SIN migración.
#   NO toca money code, access control, ni el where/scope (sigue siendo tenantId-only).
#
# POR QUÉ: en corpus el dashboard mostraba la flota completa pero /vehicles solo ~181.
#   El dashboard cuenta con prisma.vehicle.findMany SIN take (total real). La lista
#   /api/vehicles topaba en take = Math.min(limit||200, 500) y el frontend nunca pasaba
#   limit → se truncaba a 200, y tras filtrar SOLD/OOS en el header (totalEffectiveFleet)
#   quedaban 181. Corpus tiene >200 unidades. Mismo patrón que el fix de reservations
#   en beta.149 (lista topada vs count exacto del tile).
#
# QUÉ ENTRA:
#   - backend vehicles.service.js: cap del take 500 → 2000 (default sigue 200).
#   - frontend vehicles/page.js: la lista pide /api/vehicles?limit=2000.
#   - frontend app/page.js: el fallback de flota (usuarios sin overview) pide ?limit=2000.
#   - frontend checkout-wizard: el picker de carros disponibles pide ?status=AVAILABLE&limit=2000.
#
# FOLLOW-UP (item en Monday, NO en este ship): paginación real { rows, total } en el
#   backend + frontend para no depender de un tope fijo cuando las flotas crezcan.
#
# Deploy: build backend + worker + frontend + force-recreate. Hard refresh del frontend.
#   Re-test: abrir /vehicles en corpus → el conteo debe igualar el tile del dashboard.
#   NO requiere nada del usuario más que el hard refresh.
#
# FILES:
#   backend/src/modules/vehicles/vehicles.service.js
#   frontend/src/app/vehicles/page.js
#   frontend/src/app/page.js
#   frontend/src/app/reservations/[id]/checkout-wizard/page.js
#   .deploy-notes/2026-06-15-ship-vehicles-list-cap-beta173.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.173"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/vehicles/vehicles.service.js"
  "frontend/src/app/vehicles/page.js"
  "frontend/src/app/page.js"
  "frontend/src/app/reservations/[id]/checkout-wizard/page.js"
  ".deploy-notes/2026-06-15-ship-vehicles-list-cap-beta173.sh"
)

# ── GATES
node --check backend/src/modules/vehicles/vehicles.service.js
grep -nq "Math.min(Number(limit) || 200, 2000)" backend/src/modules/vehicles/vehicles.service.js || { echo "ABORT: backend cap no es 2000." >&2; exit 1; }
grep -nq "api(scopedPath('/api/vehicles?limit=2000')" frontend/src/app/vehicles/page.js || { echo "ABORT: vehicles/page.js no pide limit=2000." >&2; exit 1; }
grep -nq "/api/vehicles?limit=2000" frontend/src/app/page.js || { echo "ABORT: app/page.js no pide limit=2000." >&2; exit 1; }
grep -nq "/api/vehicles?status=AVAILABLE&limit=2000" "frontend/src/app/reservations/[id]/checkout-wizard/page.js" || { echo "ABORT: checkout-wizard no pide limit=2000." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(vehicles): raise list take cap 500->2000 + explicit limit so full fleet shows

The /vehicles list capped at take=Math.min(limit||200,500) while the frontend never
passed a limit, so corpus (>200 units) was silently truncated to 200 and showed ~181
after the SOLD/OOS header filter, even though the dashboard (uncapped findMany) showed
the real total. Raise the cap to 2000 and have the vehicles list, the home fleet
fallback, and the checkout-wizard available-vehicle picker request limit=2000.
No migration, no money/access-control changes, scope still tenantId-only.
Follow-up: real { rows, total } pagination (tracked in Monday)."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh, verify /vehicles == dashboard tile in corpus."
