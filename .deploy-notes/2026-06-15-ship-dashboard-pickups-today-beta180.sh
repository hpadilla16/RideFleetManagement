#!/usr/bin/env bash
# v0.9.0-beta.180 — Dashboard: Pickups/Returns de hoy correctos (no más "0")
#   bash .deploy-notes/2026-06-15-ship-dashboard-pickups-today-beta180.sh
#
# BACKEND + FRONTEND, code-only, sin migración. NO money.
#
# BUG: el dashboard derivaba "Pickups/Returns de hoy" filtrando del lado del
# cliente sobre /api/reservations?limit=500 (capeado). En corpus (2,856 reservas)
# los 92 pickups de hoy no caben en las 500 más recientes → el board mostraba 0,
# mientras la página de Reservations (/api/reservations/summary) decía 92.
# Mismo patrón que el bug del cap de vehicles.
#
# FIX:
#   - backend reservations.service: nuevos filtros de lista ?filter=pickups-today
#     y ?filter=returns-today, con la MISMA ventana tenant-TZ que summary()
#     (pickupAt/returnAt dentro del día). No capeado por relevancia (date-scoped).
#   - frontend dashboard: para HOY, el board toma pickups/returns de esos fetches
#     dedicados (no del array capeado); otros días siguen usando el array (el
#     selector de fecha sigue funcionando). Count y lista ahora cuadran y matchean
#     la página de Reservations.
#
# Deploy: build backend + worker + FRONTEND + force-recreate. Hard refresh del dashboard.
#   Smoke (corpus): el board "Pickups" debe mostrar el número real (no 0) = el de
#   Reservations.
#
# FILES:
#   backend/src/modules/reservations/reservations.service.js
#   frontend/src/app/page.js
#   .deploy-notes/2026-06-15-ship-dashboard-pickups-today-beta180.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.180"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservations.service.js"
  "frontend/src/app/page.js"
  ".deploy-notes/2026-06-15-ship-dashboard-pickups-today-beta180.sh"
)

# ── GATES
node --check backend/src/modules/reservations/reservations.service.js
grep -nq "pickups-today" backend/src/modules/reservations/reservations.service.js || { echo "ABORT: filtro pickups-today falta en backend." >&2; exit 1; }
grep -nq "returns-today" backend/src/modules/reservations/reservations.service.js || { echo "ABORT: filtro returns-today falta en backend." >&2; exit 1; }
grep -nq "filter=pickups-today" frontend/src/app/page.js || { echo "ABORT: fetch pickups-today falta en el dashboard." >&2; exit 1; }
grep -nq "pickupsTodayRows" frontend/src/app/page.js || { echo "ABORT: estado pickupsTodayRows falta." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(dashboard): today's pickups/returns from date-scoped query (not capped list)

The Operations Board derived today's pickups/returns by filtering a capped
/api/reservations?limit=500 array client-side, so a tenant with >500 reservations
(corpus: 2856) showed 0 while the Reservations page summary showed 92. Add
?filter=pickups-today / returns-today list filters (same tenant-TZ window as
summary) and have the dashboard fetch those for today, so count+list match."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh dashboard."
