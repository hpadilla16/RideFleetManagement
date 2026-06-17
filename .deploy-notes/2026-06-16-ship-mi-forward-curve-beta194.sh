#!/usr/bin/env bash
# v0.9.0-beta.194 — Market Intelligence: forecasting view (forward booking curve) + 60d pill.
#   bash .deploy-notes/2026-06-16-ship-mi-forward-curve-beta194.sh
#
# BACKEND + FRONTEND, code-only, SIN migración. NO money.
#
# POR QUÉ: el chart del SIPP mostraba historial por observedAt (cómo se movió el mercado en
# los días que llevamos scrapeando ~16d), así que 30d/90d "no hacían nada" (no hay tanto
# historial). Pero el módulo es FORECASTING: el scrape cubre 60 días de pickup dates FUTUROS.
# Ahora el chart mira hacia adelante.
#
# QUE ENTRA:
#   - getMarketHistory({ mode }): nuevo modo 'forward' — agrupa por pickupDate FUTURO usando
#     el quote más reciente por (pickupDate, vendor); ventana [hoy, hoy+N]. 'history' (default)
#     queda igual (observedAt). Ruta /api/market/history pasa ?mode=. Return incluye `mode`.
#   - SIPP detail (/market/[sipp]): fetch con mode=forward; pills 7/14/30/**60** (era 90, el
#     scrape es 60d); header "Market forecast — next N days"; subtítulo "forward booking curve";
#     leaderboard "Current" = pickup date más cercano (no el más lejano) en modo forward.
#   - Dashboard (/market): sparklines/delta de las tarjetas también en mode=forward (curva
#     forward del mercado por clase).
#
# Deploy: build backend + worker + FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   backend/src/modules/market-observations/market-observations.service.js
#   backend/src/modules/market-observations/market-observations.routes.js
#   frontend/src/app/market/page.js
#   frontend/src/app/market/[sipp]/page.js
#   .deploy-notes/2026-06-16-ship-mi-forward-curve-beta194.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.194"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/market-observations/market-observations.service.js"
  "backend/src/modules/market-observations/market-observations.routes.js"
  "frontend/src/app/market/page.js"
  "frontend/src/app/market/[sipp]/page.js"
  ".deploy-notes/2026-06-16-ship-mi-forward-curve-beta194.sh"
)

# ── GATES
node --check backend/src/modules/market-observations/market-observations.service.js
node --check backend/src/modules/market-observations/market-observations.routes.js
grep -nq "isForward" backend/src/modules/market-observations/market-observations.service.js || { echo "ABORT: modo forward falta." >&2; exit 1; }
grep -nq "mode: req.query.mode" backend/src/modules/market-observations/market-observations.routes.js || { echo "ABORT: ruta no pasa mode." >&2; exit 1; }
grep -nq "mode=forward" "frontend/src/app/market/[sipp]/page.js" || { echo "ABORT: SIPP no pide forward." >&2; exit 1; }
grep -nq "mode=forward" frontend/src/app/market/page.js || { echo "ABORT: dashboard no pide forward." >&2; exit 1; }
grep -nq "value: 60, label: '60d'" "frontend/src/app/market/[sipp]/page.js" || { echo "ABORT: pill 60d falta." >&2; exit 1; }
grep -nq "Market forecast" "frontend/src/app/market/[sipp]/page.js" || { echo "ABORT: header forecast falta." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market): forward booking-curve forecasting view + 60d pill

The SIPP chart showed observedAt history (~16d of scraping) so 30d/90d added nothing. The
module is forecasting: the scrape covers 60 future pickup dates. getMarketHistory gains a
'forward' mode that groups by future pickupDate using the latest quote per (date,vendor) over
[today, today+N]; the SIPP detail + dashboard now request mode=forward, pills are 7/14/30/60,
header reads 'Market forecast — next N days', and the leaderboard 'Current' uses the nearest
pickup date. History mode unchanged. No migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh."
