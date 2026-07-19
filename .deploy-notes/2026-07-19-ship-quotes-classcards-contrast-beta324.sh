#!/usr/bin/env bash
# v0.9.0-beta.324 — HOTFIX: cards de precio del New Quote casi invisibles (texto blanco).
#   bash .deploy-notes/2026-07-19-ship-quotes-classcards-contrast-beta324.sh
#
# FRONTEND ONLY, SIN migración. Reportado por Hector en prod (beta.323) con screenshot.
#
# CAUSA: el must-change de accesibilidad de GD convirtió las class cards del panel
# New Quote en <button> reales — y el estilo global de button del app pinta texto
# BLANCO (+ font propio). Con background:transparent inline, el texto quedaba blanco
# sobre panel claro = ilegible. El E2E visual corrió ANTES de ese cambio; después solo
# se re-compiló (lección: cambio de markup → re-verificar visual, no solo build).
# FIX: color:'inherit', font:'inherit', textShadow:'none' en el estilo inline del
# button — hereda la tinta del panel en light Y dark. Verificado en browser en ambos
# temas (dev stack, precios del motor real).
#
# DEPLOY (FRONTEND ONLY):
#   git fetch --tags && git checkout v0.9.0-beta.324
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
#   (hard refresh después)
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.324"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

FILES=(
  frontend/src/app/quotes/page.js
  .deploy-notes/2026-07-19-ship-quotes-classcards-contrast-beta324.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git status --short --branch
git commit -m "fix(quotes): class-card buttons inherit panel text color — were invisible

The GD a11y fix made the live-price class cards real <button> elements; the
app's global button style paints white text, which on the light panel made
class names and prices nearly unreadable (prod report with screenshot).
Inline color/font inherit restores the panel ink in both themes. Browser-
verified light + dark against live engine prices.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
