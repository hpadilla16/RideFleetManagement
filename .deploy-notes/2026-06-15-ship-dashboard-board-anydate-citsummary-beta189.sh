#!/usr/bin/env bash
# v0.9.0-beta.189 — Dashboard board para CUALQUIER fecha + fix del /citations/summary
#   bash .deploy-notes/2026-06-15-ship-dashboard-board-anydate-citsummary-beta189.sh
#
# BACKEND + FRONTEND, code-only, sin migración. NO money.
#
# BUG 1: el board del dashboard mostraba 0 pickups/returns al elegir una fecha
#   distinta a HOY (el fix previo solo cubría hoy; otras fechas caían al array
#   capeado de 500). Fix: el board ahora hace fetch date-scoped por la fecha
#   seleccionada — pickups por ?dateOn=, returns por un ?returnDateOn= nuevo en
#   /api/reservations/page. Correcto para cualquier día sin importar el volumen.
# BUG 2: GET /api/citations/summary daba 400 ("Invalid value for notIn. Expected
#   CitationStatus") porque usaba estados inexistentes (PAID/CLOSED). Fix:
#   notIn ['VOID','DISPUTED'] (enum real). El tile de Citations ya carga.
#
# Deploy: build backend + worker + FRONTEND + force-recreate + HARD REFRESH.
#   Smoke: dashboard → cambiar la fecha del board → pickups/returns reales (no 0);
#   el tile "Citations" carga sin 400.
#
# FILES:
#   backend/src/modules/reservations/reservations.service.js
#   backend/src/modules/reservations/reservations.routes.js
#   backend/src/modules/citations/citations.service.js
#   frontend/src/app/page.js
#   .deploy-notes/2026-06-15-ship-dashboard-board-anydate-citsummary-beta189.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.189"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/src/modules/citations/citations.service.js"
  "frontend/src/app/page.js"
  ".deploy-notes/2026-06-15-ship-dashboard-board-anydate-citsummary-beta189.sh"
)

# ── GATES
node --check backend/src/modules/reservations/reservations.service.js
node --check backend/src/modules/reservations/reservations.routes.js
node --check backend/src/modules/citations/citations.service.js
grep -nq "returnDateOn" backend/src/modules/reservations/reservations.service.js || { echo "ABORT: returnDateOn falta en service." >&2; exit 1; }
grep -nq "returnDateOn" backend/src/modules/reservations/reservations.routes.js || { echo "ABORT: returnDateOn falta en route." >&2; exit 1; }
grep -nq "notIn: \['VOID', 'DISPUTED'\]" backend/src/modules/citations/citations.service.js || { echo "ABORT: fix del enum summary falta." >&2; exit 1; }
grep -nq "returnDateOn=\${boardDate}" frontend/src/app/page.js || { echo "ABORT: board date-driven falta en el dashboard." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(dashboard): date-scoped pickups/returns for any board date + citations summary enum

The Operations Board now fetches the selected day's pickups (?dateOn) and returns
(new ?returnDateOn on /api/reservations/page) instead of filtering a capped list, so
changing the board date shows the real counts for any day (not 0). Also fix
/api/citations/summary which 400'd on invalid CitationStatus values (PAID/CLOSED) ->
notIn ['VOID','DISPUTED'] so the dashboard Citations tile loads."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh."
