#!/usr/bin/env bash
# v0.9.0-beta.214 — Fix layout del panel Admin Corrections (lista de cargos).
#   bash .deploy-notes/2026-06-22-ship-admin-corrections-charges-layout-fix-beta214.sh
#
# FRONTEND-only, SIN migración. NO toca lógica de dinero (solo presentación).
#
# BUG (beta.213): en el panel ⚙️ Admin Corrections, la lista "Current charges" usaba un <table>;
# un CSS global de las cards colapsaba las celdas 2ª/3ª → el monto y el botón "Void" quedaban
# invisibles (los botones SÍ estaban en el DOM y eran clickables, pero no se veían).
# FIX: reemplazar el <table> por filas flex (div) con anchos explícitos (nombre flex, monto 90px,
# botón flexShrink:0) → siempre visibles, sin depender del CSS global de tablas.
#
# Verificado local: esbuild parse de page.js ✅. El 'next build' del docker valida el JSX.
#
# DEPLOY (FRONTEND ONLY):
#   git fetch --tags && git checkout v0.9.0-beta.214
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
#   # Sin migración. HARD REFRESH (Cmd+Shift+R) tras el deploy para botar el bundle viejo.
#
# FILES:
#   frontend/src/app/reservations/[id]/page.js
#   .deploy-notes/2026-06-22-ship-admin-corrections-charges-layout-fix-beta214.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.214"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/reservations/[id]/page.js"
  ".deploy-notes/2026-06-22-ship-admin-corrections-charges-layout-fix-beta214.sh"
)

# ── SANITY GATES ──
grep -q "Current charges" "frontend/src/app/reservations/[id]/page.js" || { echo "ABORT: falta el panel" >&2; exit 1; }
grep -q "flexShrink: 0" "frontend/src/app/reservations/[id]/page.js" || { echo "ABORT: el fix flex no está aplicado" >&2; exit 1; }
node -e "const s=require('fs').readFileSync('frontend/src/app/reservations/[id]/page.js','utf8'); const b=(s.match(/{/g)||[]).length-(s.match(/}/g)||[]).length,p=(s.match(/\(/g)||[]).length-(s.match(/\)/g)||[]).length; if(b||p){console.error('unbalanced braces/parens',b,p);process.exit(1)}" || { echo "ABORT: desbalanceado" >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reservations): Admin Corrections charges list — flex rows so amount + Void show

The beta.213 panel rendered the 'Current charges' list as a <table>; a global card CSS
collapsed the 2nd/3rd cells so the amount and the Void button were invisible (the buttons
were in the DOM and clickable, just not visible). Replaced the table with flex rows with
explicit widths so the amount and Void button always render. Frontend-only; no migration;
no money logic."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build FRONTEND → force-recreate. Sin migración. HARD REFRESH después."
