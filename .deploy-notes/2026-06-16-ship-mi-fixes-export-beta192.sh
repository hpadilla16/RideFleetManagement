#!/usr/bin/env bash
# v0.9.0-beta.192 — Market Intelligence: fix dead buttons + RateHighway-style Excel export.
#   bash .deploy-notes/2026-06-16-ship-mi-fixes-export-beta192.sh
#
# BACKEND + FRONTEND, code-only, SIN migración. NO money.
#
# QUE ENTRA:
#   FIXES (frontend-only):
#     - Dashboard 7d/14d/30d pills: el rangeDays se seteaba pero el fetch hardcodeaba
#       days=14 y no estaba en las deps del effect → no hacían nada. Ahora refetchea con
#       &days=${rangeDays} (el backend ya lo soporta) + sparkline/delta range-aware
#       (DeltaBadge muestra el rango real). (market/page.js)
#     - "Chase" y "Edit rate" daban 404: empujaban a /rates/:id/edit que NO existe.
#       Corregido a /rates/:id/pricing (la página que sí existe). (market/[sipp]/page.js)
#   FEATURE (export Excel estilo RateHighway):
#     - market-scrape-comparison.service.js: buildRunComparisonWorkbook(runId) reusa
#       computeRunComparison + renderReportExcel (exceljs). 3 hojas: "Suggested by class &
#       day" (pivot SIPP×día), "Market cheapest" (pivot), "Detail" (flat con cheapest/
#       current/suggested/delta/samples).
#     - market-scraper.routes.js: GET /api/market-scraper/runs/:runId/export.xlsx
#       (authed, tenant-scoped, mismo guard del módulo) → streamea el .xlsx.
#     - market-intelligence/page.js: botón "⬇ Export Excel" en la vista de comparación
#       (descarga blob con el Bearer token).
#
# Deploy: build backend + worker + FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   backend/src/modules/market-scraper/market-scrape-comparison.service.js
#   backend/src/modules/market-scraper/market-scraper.routes.js
#   frontend/src/app/market/page.js
#   frontend/src/app/market/[sipp]/page.js
#   frontend/src/app/market-intelligence/page.js
#   .deploy-notes/2026-06-16-ship-mi-fixes-export-beta192.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.192"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  "backend/src/modules/market-scraper/market-scraper.routes.js"
  "frontend/src/app/market/page.js"
  "frontend/src/app/market/[sipp]/page.js"
  "frontend/src/app/market-intelligence/page.js"
  ".deploy-notes/2026-06-16-ship-mi-fixes-export-beta192.sh"
)

# ── GATES
node --check backend/src/modules/market-scraper/market-scrape-comparison.service.js
node --check backend/src/modules/market-scraper/market-scraper.routes.js
grep -nq "buildRunComparisonWorkbook" backend/src/modules/market-scraper/market-scrape-comparison.service.js || { echo "ABORT: builder del export falta." >&2; exit 1; }
grep -nq "runs/:runId/export.xlsx" backend/src/modules/market-scraper/market-scraper.routes.js || { echo "ABORT: ruta export falta." >&2; exit 1; }
grep -nq "days=\${rangeDays}" frontend/src/app/market/page.js || { echo "ABORT: fix de rangeDays falta." >&2; exit 1; }
grep -nq "/pricing\`" "frontend/src/app/market/[sipp]/page.js" || { echo "ABORT: fix de ruta /pricing falta." >&2; exit 1; }
grep -nq "Export Excel" frontend/src/app/market-intelligence/page.js || { echo "ABORT: botón Export Excel falta." >&2; exit 1; }
grep -nq "/rates/\${encodeURIComponent(rateId)}/edit" "frontend/src/app/market/[sipp]/page.js" && { echo "ABORT: todavía queda un /rates/:id/edit (404)." >&2; exit 1; } || true
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(market): wire 7d/14d/30d pills + fix Chase/Edit-rate 404 + Excel export

Dashboard range pills now refetch with days=rangeDays (was hardcoded 14, state unused) and
the delta/sparkline are range-aware. Chase / Edit-rate / Configure-rule pushed a nonexistent
/rates/:id/edit route (client 404) — corrected to /rates/:id/pricing. New RateHighway-style
Excel: GET /api/market-scraper/runs/:runId/export.xlsx (buildRunComparisonWorkbook reuses
computeRunComparison + renderReportExcel) with Suggested-by-class&day + Market-cheapest pivots
and a flat Detail sheet; '⬇ Export Excel' button on the comparison view. No migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh."
