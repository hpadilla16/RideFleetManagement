#!/usr/bin/env bash
# v0.9.0-beta.183 — REPORTES: scroll horizontal en las tablas (frontend-only)
#   bash .deploy-notes/2026-06-15-ship-report-tables-hscroll-beta183.sh
#
# Sin migración. Sin backend. Solo UI.
#
# FIX: las tablas de los reportes Commission & Sales Performance y Agent Track
# Record usaban un wrapper con `overflow: 'hidden'`, así que con muchos
# empleados/servicios las columnas se cortaban (Hector no podía ver toda la
# info). Cambio a `overflowX: 'auto'` + `minWidth: max-content` en el <table>:
# las columnas mantienen su ancho natural y la tabla scrollea izquierda/derecha
# en vez de aplastarse. Afecta las 3 tablas de cada reporte (mismo componente).
#
# FILES:
#   frontend/src/app/reports-v2/commission-sales-performance/page.js
#   frontend/src/app/reports-v2/agent-track-record/page.js
#   .deploy-notes/2026-06-15-ship-report-tables-hscroll-beta183.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.183"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/reports-v2/commission-sales-performance/page.js"
  "frontend/src/app/reports-v2/agent-track-record/page.js"
  ".deploy-notes/2026-06-15-ship-report-tables-hscroll-beta183.sh"
)

# ── GUARDS — el wrapper ya scrollea y el table tiene minWidth.
for f in "frontend/src/app/reports-v2/commission-sales-performance/page.js" "frontend/src/app/reports-v2/agent-track-record/page.js"; do
  grep -nq "overflowX: 'auto'" "$f" || { echo "ABORT: $f no tiene overflowX auto." >&2; exit 1; }
  grep -nq "minWidth: 'max-content'" "$f" || { echo "ABORT: $f no tiene minWidth max-content." >&2; exit 1; }
  ! grep -nq "overflow: 'hidden', background: 'white'" "$f" || { echo "ABORT: $f todavia tiene overflow hidden." >&2; exit 1; }
done
echo "Guards OK."

# ── FRONTEND build.
( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build falló — corre 'cd frontend && npm run build' para ver el error." >&2; exit 1; }

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reports): horizontal scroll on commission/agent report tables

The per-clerk metrics and sales-attach tables wrapped the <table> in a div with
overflow:hidden, so with many clerks/services the right-hand columns were cut
off. Switch to overflowX:auto + minWidth:max-content so columns keep their
natural width and the table scrolls left/right instead of squishing."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. En el droplet (frontend — build + force-recreate):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build frontend \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate frontend"
echo
echo "VERIFY: hard refresh del reporte Commission & Sales Performance — las tablas"
echo "  de Per-clerk metrics y Sales attach % deben scrollear left/right sin cortar."
