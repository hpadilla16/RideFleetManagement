#!/usr/bin/env bash
# v0.9.0-beta.203 — Market Intelligence: tu rate en las cards/gráficas como ALL-IN (apples-to-apples).
#   bash .deploy-notes/2026-06-19-ship-your-rate-allin-dashboard-beta203.sh
#
# Backend + frontend, code-only, SIN migración. ZERO charge logic (solo display + ranking).
#
# PROBLEMA: las gráficas/cards de MI muestran el ALL-IN del competidor (effectiveDailyPrice), pero
# "your rate" salía de Rate.daily = tu BASE. Comparaba all-in vs base → te veías más barato de lo
# real y el rank estaba mal.
#
# QUE ENTRA (solo cuando la location tiene MarketPricingConfig — opt-in):
#   getMarketSummary: yourRate.daily ahora es tu ALL-IN (base × grossup de la config), y el yourRank
#   se calcula contra el all-in de los competidores. Se añade yourRate.base + yourRate.allIn para el UI.
#   Sin config → queda como antes (daily = base). Frontend (market dashboard card): muestra
#   "all-in · base $X" debajo del precio cuando allIn=true.
#
# Verificado: node --check OK; 31/31 tests; smoke de getMarketSummary con config SJU Titanium →
# yourRate {daily:78.67, base:53.69, allIn:true}, rank #1 vs [Payless 78.67, Budget 90].
#
# Deploy: build BACKEND + FRONTEND + force-recreate. SIN migración.
#
# FILES:
#   backend/src/modules/market-observations/market-observations.service.js
#   frontend/src/app/market/page.js
#   .deploy-notes/2026-06-19-ship-your-rate-allin-dashboard-beta203.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.203"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/market-observations/market-observations.service.js"
  "frontend/src/app/market/page.js"
  ".deploy-notes/2026-06-19-ship-your-rate-allin-dashboard-beta203.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/market-observations/market-observations.service.js || { echo "ABORT: node --check observations" >&2; exit 1; }
grep -q "customerAllInFromBase" backend/src/modules/market-observations/market-observations.service.js || { echo "ABORT: summary no usa el grossup." >&2; exit 1; }
grep -q "all-in · base" frontend/src/app/market/page.js || { echo "ABORT: frontend sin el hint de base." >&2; exit 1; }
( cd backend && node --test src/modules/market-scraper/pricing-grossup.test.mjs src/modules/market-scraper/market-vendor.test.mjs src/modules/market-scraper/market-scrape-comparison.test.mjs >/dev/null 2>&1 ) \
  && echo "market tests OK" || { echo "ABORT: market tests fallaron." >&2; exit 1; }
echo "Guards OK. (Frontend lo valida el 'next build' del docker build.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(market): show your rate as all-in on the MI dashboard (apples-to-apples)

The MI charts plot the competitor ALL-IN (effectiveDailyPrice) but 'your rate' came
from Rate.daily = your BASE, so the card compared all-in vs base and you looked
cheaper than reality with a wrong rank. When a location has a MarketPricingConfig,
getMarketSummary now returns yourRate.daily as your ALL-IN (base × grossup) and ranks
you against the competitor all-in, plus yourRate.base/allIn for the UI. Without a
config the behavior is unchanged. The dashboard card shows 'all-in · base \$X'. Display
+ ranking only — no charge logic. No migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend+frontend → force-recreate. Sin migración."
