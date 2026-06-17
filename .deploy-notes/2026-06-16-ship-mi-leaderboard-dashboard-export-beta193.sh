#!/usr/bin/env bash
# v0.9.0-beta.193 — Market Intelligence: fix vendor-leaderboard $0/-100% bug + dynamic
#   range labels + Export Excel button ON THE DASHBOARD (discoverable).
#   bash .deploy-notes/2026-06-16-ship-mi-leaderboard-dashboard-export-beta193.sh
#
# BACKEND + FRONTEND, code-only, SIN migración. NO money.
#
# QUE ENTRA:
#   FIX leaderboard (market/[sipp]/page.js):
#     - Vendors no observados el último día salían con Current $0.00, Δ -100% y rank #1
#       porque Number(null)===0 pasaba el filtro isFinite. Ahora se filtran los nulls ANTES
#       de Number() → current = último precio real, ranking correcto.
#     - Headers "14d avg / 14d Δ" eran fijos: ahora son dinámicos al pill (7/14/30/90d).
#   EXPORT discoverable:
#     - market-observations: buildAirportExportWorkbook(airport) resuelve el último run con
#       data del aeropuerto y reusa buildRunComparisonWorkbook (prices + suggested por clase
#       y día). Ruta GET /api/market/export.xlsx?airport= (authed, tenant-scoped).
#     - Dashboard (/market): botón "⬇ Export Excel" en el TopBar (al lado de Profiles) →
#       descarga blob con el Bearer token. (El botón per-run en la vista de comparación de
#       /market-intelligence sigue ahí desde beta.192.)
#
# Deploy: build backend + worker + FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   backend/src/modules/market-observations/market-observations.service.js
#   backend/src/modules/market-observations/market-observations.routes.js
#   frontend/src/app/market/page.js
#   frontend/src/app/market/[sipp]/page.js
#   .deploy-notes/2026-06-16-ship-mi-leaderboard-dashboard-export-beta193.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.193"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/market-observations/market-observations.service.js"
  "backend/src/modules/market-observations/market-observations.routes.js"
  "frontend/src/app/market/page.js"
  "frontend/src/app/market/[sipp]/page.js"
  ".deploy-notes/2026-06-16-ship-mi-leaderboard-dashboard-export-beta193.sh"
)

# ── GATES
node --check backend/src/modules/market-observations/market-observations.service.js
node --check backend/src/modules/market-observations/market-observations.routes.js
grep -nq "buildAirportExportWorkbook" backend/src/modules/market-observations/market-observations.service.js || { echo "ABORT: builder del airport export falta." >&2; exit 1; }
grep -nq "export.xlsx" backend/src/modules/market-observations/market-observations.routes.js || { echo "ABORT: ruta export del dashboard falta." >&2; exit 1; }
grep -nq "Export Excel" frontend/src/app/market/page.js || { echo "ABORT: botón Export en el dashboard falta." >&2; exit 1; }
grep -nq "Number(null)" "frontend/src/app/market/[sipp]/page.js" || { echo "ABORT: comentario/fix del leaderboard falta." >&2; exit 1; }
grep -nq "{days}d avg" "frontend/src/app/market/[sipp]/page.js" || { echo "ABORT: labels dinámicos del leaderboard faltan." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(market): leaderboard \$0/-100% phantom + dynamic range labels + dashboard Excel export

Leaderboard filtered vendor prices with Number(p.price) THEN isFinite — Number(null)===0
slipped a phantom \$0 'current' through and ranked unobserved vendors #1 with -100% delta.
Now nulls are dropped before Number(); current = last real price. '14d avg/Δ' headers are
dynamic to the selected pill. New GET /api/market/export.xlsx?airport= resolves the latest
run with data and reuses buildRunComparisonWorkbook; '⬇ Export Excel' button on the /market
dashboard TopBar (discoverable). No migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh."
