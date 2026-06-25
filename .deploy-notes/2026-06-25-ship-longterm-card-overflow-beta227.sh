#!/usr/bin/env bash
# v0.9.0-beta.227 — FIX UI: la tabla Billing Cycles del Long-Term Plan se salía de la tarjeta.
#   bash .deploy-notes/2026-06-25-ship-longterm-card-overflow-beta227.sh
#
# FRONTEND-only, SIN migración. No toca money.
#
# SÍNTOMA: en la tarjeta del Long-Term Plan, la tabla de Billing Cycles (col. Period + botón
# "Mark Paid") era más ancha que la tarjeta y el botón se salía del borde.
# FIX (reservations/[id]/page.js): envolver la <table> en un <div overflowX:auto; maxWidth:100%>
# y darle a la tabla width:100%; + a la tarjeta minWidth:0 + overflowWrap:anywhere (para que un
# padre flex no la apriete y el contenido no desborde). Solo CSS inline; cero lógica.
#
# Verificado local: esbuild --loader=jsx parsea limpio (exit 0). El 'next build' del docker valida el JSX.
#
# DEPLOY (FRONTEND only, sin migración):
#   git fetch --tags && git checkout v0.9.0-beta.227
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
#   # Hard refresh (Cmd+Shift+R) tras deploy.
#
# FILES:
#   frontend/src/app/reservations/[id]/page.js
#   .deploy-notes/2026-06-25-ship-longterm-card-overflow-beta227.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.227"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/reservations/[id]/page.js"
  ".deploy-notes/2026-06-25-ship-longterm-card-overflow-beta227.sh"
)

# ── SANITY GATES ──
grep -q "overflowX: 'auto', maxWidth: '100%'" "frontend/src/app/reservations/[id]/page.js" || { echo "ABORT: falta el wrapper de overflow" >&2; exit 1; }
( cd frontend && npx --yes esbuild --loader=jsx < "src/app/reservations/[id]/page.js" > /dev/null ) || { echo "ABORT: el JSX no parsea" >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX completo.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(ui): keep the Long-Term Plan billing-cycles table inside its card

The Billing Cycles table (Period column + Mark Paid button) was wider than the plan card, so
the button spilled past the right edge. Wrap the table in an overflow-x:auto / maxWidth:100%
container with table width:100%, and give the card minWidth:0 + overflowWrap:anywhere so a flex
parent can't squeeze it. CSS-only, no logic change. Frontend-only, no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build FRONTEND → force-recreate frontend → hard refresh."
