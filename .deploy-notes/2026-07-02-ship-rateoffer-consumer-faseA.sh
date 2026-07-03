#!/usr/bin/env bash
# RateOffer consumer Fase A: dashboard/exports/history leen Kayak; pricing GATEADO.
#   bash .deploy-notes/2026-07-02-ship-rateoffer-consumer-faseA.sh
#   (tag default v0.9.0-beta.283 — override: TAG_OVERRIDE=v0.9.0-beta.NNN)
#
# BACKEND-only, SIN migración, SIN cambios de frontend (shapes de respuesta intactos).
# Pipeline completo: Plan → build → Innovation (MUST: purpose default FAIL-CLOSED,
# implementado + test que lo fija) → QA FIX-FIRST (export Excel calculaba "Uploaded Rate"
# con teasers de Kayak — corregido: columnas de pricing desde pool gate-filtrado) → verde.
#
# QUÉ (cutover decidido por Hector): el scraper Kayak escribe RateOffer a diario desde
# el droplet (el Expedia directo murió Jul 1 — MarketObservation ya no recibe data).
# Nuevo adapter dual-read `rate-offer-source.js` (loadCompetitorRows con purpose
# 'display'|'pricing'):
#   - vendor = supplier (la agencia); provider (el OTA) es dimensión nueva additive.
#   - Ladder de precios = ladder de AGENCIAS (min por supplier across providers).
#   - supplier='' fuera del pool competitivo (una exclusión no puede atrapar un
#     supplier anónimo — tu marca podría esconderse ahí).
#   - Precedencia: EXPEDIA_DIRECT gana sobre KAYAK provider='Expedia' (mismo date/sipp/
#     supplier) si el scraper directo revive.
#   - ⚠️ GATE DE PRICING (protege las 15 PricingRule mode=AUTO vivas): las filas KAYAK
#     NO entran a NINGÚN cálculo de precio (comparison→applyRunSuggestions, suggestion
#     engine, columnas Suggested/Uploaded del export) hasta confirmar que su
#     effectiveDailyPrice es ALL-IN. Hoy es teaser total/lorDays SIN fees → el gross-up
#     tax-aware (beta.202) back-solvearía bases ~18-25% bajas = auto-subcotizarse.
#     Default FAIL-CLOSED: caller sin purpose = pricing (Kayak excluido); QA lo falsificó
#     experimentalmente (quitar el default rompe el test).
#     FLIP: cuando el scraper team confirme all-in → editar .env del droplet
#     KAYAK_EFFECTIVE_IS_ALL_IN="true" + `docker compose -f docker-compose.prod.yml
#     restart backend worker` (global, sin rebuild).
# Consumers switcheados: market summary/forward/history/export, computeRunComparison,
# pricing-suggestion-engine (evaluateRule + resolveSippForRate), getRunCheapestPerSipp.
# History queda dual-read (chart continuo pre/post Jul-1).
#
# GAPS ACEPTADOS (QA): listObservations (drill-down crudo de run) sigue legacy-only —
# runs Kayak se ven por getRunCheapestPerSipp pero no ahí · market-onboarding discovery
# legacy-only (fail-safe, breadcrumb en código: al switchearlo usar purpose 'pricing') ·
# reads del adapter sin select/take (OK a ~165 offers; Fase B: proyecciones + cap antes
# de que Kayak crezca 10-50x) · flip del flag = global, no por tenant (Fase B: config DB).
#
# PARA EL SCRAPER TEAM (relay): backend ya consume RateOffer en todo; falta SU
# confirmación de all-in para abrir el pricing. observationsCount sin cambios.
#
# ── SMOKE ──
#   Dashboard /market (International/SJU): cards y history muestran data fresca de hoy
#   (Kayak, 9 providers). /market-intelligence → runs Kayak con comparison (usando solo
#   fuentes no-Kayak para suggested mientras el gate esté cerrado). Export xlsx: columnas
#   "Market cheapest" con Kayak; "Suggested/Uploaded" solo de fuentes confirmadas (pueden
#   venir vacías si el cell solo tiene Kayak — esperado hasta el flip).
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#   # y añadir al .env del droplet (env-diff-check lo va a exigir):
#   #   KAYAK_EFFECTIVE_IS_ALL_IN="false"
#
# FILES:
#   backend/src/modules/market-scraper/rate-offer-source.js
#   backend/src/modules/market-scraper/rate-offer-source.test.mjs
#   backend/src/modules/market-scraper/market-scrape-comparison.service.js
#   backend/src/modules/market-scraper/market-scrape-comparison.test.mjs
#   backend/src/modules/market-scraper/market-scrape-profile.service.js
#   backend/src/modules/market-scraper/market-scrape-profile.test.mjs
#   backend/src/modules/market-scraper/market-scrape-correction.test.mjs
#   backend/src/modules/market-observations/market-observations.service.js
#   backend/src/modules/pricing-suggestions/pricing-suggestion-engine.service.js
#   backend/src/modules/market-onboarding/market-onboarding.service.js
#   backend/package.json
#   backend/.env.example
#   .deploy-notes/2026-07-02-ship-rateoffer-consumer-faseA.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.283}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/market-scraper/rate-offer-source.js"
  "backend/src/modules/market-scraper/rate-offer-source.test.mjs"
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  "backend/src/modules/market-scraper/market-scrape-comparison.test.mjs"
  "backend/src/modules/market-scraper/market-scrape-profile.service.js"
  "backend/src/modules/market-scraper/market-scrape-profile.test.mjs"
  "backend/src/modules/market-scraper/market-scrape-correction.test.mjs"
  "backend/src/modules/market-observations/market-observations.service.js"
  "backend/src/modules/pricing-suggestions/pricing-suggestion-engine.service.js"
  "backend/src/modules/market-onboarding/market-onboarding.service.js"
  "backend/package.json"
  "backend/.env.example"
  ".deploy-notes/2026-07-02-ship-rateoffer-consumer-faseA.sh"
)

# ── SANITY GATES ──
for f in "${FILES[@]}"; do case "$f" in backend/src/*.js) node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; };; esac; done
grep -q "purpose === 'display' ? 'display' : 'pricing'" backend/src/modules/market-scraper/rate-offer-source.js || { echo "ABORT: el default de purpose no es fail-closed" >&2; exit 1; }
grep -q "byCellPricing" backend/src/modules/market-observations/market-observations.service.js || { echo "ABORT: export sin pool de pricing gate-filtrado" >&2; exit 1; }
grep -q "KAYAK_EFFECTIVE_IS_ALL_IN" backend/.env.example || { echo "ABORT: flag ausente de .env.example" >&2; exit 1; }
grep -q "rate-offer-source.test.mjs" backend/package.json || { echo "ABORT: test nuevo fuera de test:market-scraper" >&2; exit 1; }
( cd backend && npm run test:market-scraper && npm run test:rates ) || { echo "ABORT: tests fallaron" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market-intelligence): consume RateOffer (Kayak) everywhere, with a fail-closed pricing gate

The Kayak metasearch scraper writes RateOffer daily (direct Expedia dead since
Jul 1). New dual-read adapter rate-offer-source.js feeds summary/forward/
history/export, run comparison and the pricing suggestion engine: vendor =
supplier (agency ladder collapses providers), supplier='' excluded from the
competitive pool, EXPEDIA_DIRECT takes precedence over Kayak-relayed Expedia.
PRICING GATE: Kayak effectiveDailyPrice is teaser-basis (total/lorDays, no
fees) while the beta.202 tax-aware gross-up assumes ALL-IN input — feeding it
would back-solve base rates ~18-25% low and self-undercut via the 15 live AUTO
PricingRules. All price computation (applyRunSuggestions, evaluateRule,
resolveSippForRate, and the export's Suggested/Uploaded-base columns) excludes
KAYAK-source rows until KAYAK_EFFECTIVE_IS_ALL_IN='true'; loadCompetitorRows
defaults purpose to 'pricing' (fail-closed — pinned by a test QA falsified
experimentally). Display surfaces include Kayak everywhere with response
shapes unchanged. 82/82 market-scraper tests. No migration, no frontend."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"
echo "Pushed $TAG. Droplet: .env += KAYAK_EFFECTIVE_IS_ALL_IN=\"false\" → build BACKEND → recreate backend+worker. Smoke: /market muestra Kayak; export con Suggested solo de fuentes confirmadas."
