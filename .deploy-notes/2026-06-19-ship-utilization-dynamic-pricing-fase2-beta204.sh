#!/usr/bin/env bash
# v0.9.0-beta.204 — Pricing Fase 2: reglas dinámicas por utilization (proyectado a la fecha de pickup).
#   bash .deploy-notes/2026-06-19-ship-utilization-dynamic-pricing-fase2-beta204.sh
#
# Backend + frontend, CON migración aditiva. Plan: doc/market-pricing-tax-aware-plan-2026-06-19.md.
#
# ⚠️ NOTA DE DINERO: ajusta el SUGGESTED según la demanda proyectada. OPT-IN: solo aplica si la
#    location tiene MarketPricingConfig (tax-aware) Y utilizationRules cargadas. Sin reglas → igual
#    que beta.202/203. Se aplica solo con autoApply=true (default FALSE; NO se enciende aquí). No
#    toca lógica de cobro/charges.
#
# QUE ENTRA:
#   1) pricing-utilization.js: buildUtilizationLookup() REUSA el computeData del reporte "Availability
#      Forecast per Vehicle Type" (paridad exacta) → utilization proyectado por (SIPP, día de pickup)
#      = reserved/capacity (confirmed-set, por location). + pickUtilizationTier / applyUtilization-
#      Adjustment (puros, 6 tests).
#   2) Migración aditiva: MarketPricingConfig.utilizationRules JSONB ([{maxPct, adjustAmount?|adjustPct?}]).
#   3) Integración (computeRunComparison + window export): el tier AJUSTA el target all-in ENCIMA del
#      margen base, ANTES del gross-up→base. Nueva columna "Util %" en los exports tax-aware. Fila
#      gana `utilization`.
#   4) Settings → Market pricing config: editor de tiers ("maxPct: adjust" por línea, % = porcentaje,
#      número = $). get/upsert sanitizan + ordenan los tiers.
#   5) Guard defensivo: applyStrategy(null profile) → null (observación huérfana no tumba el export).
#
# Verificado: prisma validate OK; node --check OK; 37/37 tests; smoke real del window export con tier
# +10% a util 100% → Comp 78.67 / Suggested(all-in) 85.44 / Uploaded base 58.31 / Util 100% (exacto).
#
# Deploy: build BACKEND + FRONTEND + force-recreate + MIGRACIÓN (additive, 5432).
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260619_market_pricing_utilization_rules/migration.sql
#   backend/src/modules/market-scraper/pricing-utilization.js
#   backend/src/modules/market-scraper/pricing-utilization.test.mjs
#   backend/src/modules/market-scraper/market-scrape-comparison.service.js
#   backend/src/modules/market-observations/market-observations.service.js
#   backend/src/modules/settings/settings.service.js
#   frontend/src/app/settings/page.js
#   .deploy-notes/2026-06-19-ship-utilization-dynamic-pricing-fase2-beta204.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.204"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260619_market_pricing_utilization_rules/migration.sql"
  "backend/src/modules/market-scraper/pricing-utilization.js"
  "backend/src/modules/market-scraper/pricing-utilization.test.mjs"
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  "backend/src/modules/market-observations/market-observations.service.js"
  "backend/src/modules/settings/settings.service.js"
  "frontend/src/app/settings/page.js"
  ".deploy-notes/2026-06-19-ship-utilization-dynamic-pricing-fase2-beta204.sh"
)

# ── BOOT-SAFETY / SANITY GATES ──
[ -f backend/src/modules/market-scraper/pricing-utilization.js ] || { echo "ABORT: falta pricing-utilization.js" >&2; exit 1; }
[ -f backend/prisma/migrations/20260619_market_pricing_utilization_rules/migration.sql ] || { echo "ABORT: falta la migración" >&2; exit 1; }
for must in \
  "backend/src/modules/market-scraper/pricing-utilization.js" \
  "backend/prisma/migrations/20260619_market_pricing_utilization_rules/migration.sql"; do
  printf '%s\n' "${FILES[@]}" | grep -Fqx "$must" || { echo "ABORT: $must no está en FILES[]." >&2; exit 1; }
done
for f in \
  backend/src/modules/market-scraper/pricing-utilization.js \
  backend/src/modules/market-scraper/market-scrape-comparison.service.js \
  backend/src/modules/market-observations/market-observations.service.js \
  backend/src/modules/settings/settings.service.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
grep -q "utilizationRules" backend/prisma/schema.prisma || { echo "ABORT: schema sin utilizationRules." >&2; exit 1; }
grep -q "utilizationRules" backend/prisma/migrations/20260619_market_pricing_utilization_rules/migration.sql || { echo "ABORT: migración sin la columna." >&2; exit 1; }
grep -q "applyUtilizationAdjustment" backend/src/modules/market-scraper/market-scrape-comparison.service.js || { echo "ABORT: comparison no aplica el tier." >&2; exit 1; }
grep -q "Utilization tiers" frontend/src/app/settings/page.js || { echo "ABORT: frontend sin el editor de tiers." >&2; exit 1; }
( cd backend && node --test --test-force-exit \
    src/modules/market-scraper/pricing-grossup.test.mjs \
    src/modules/market-scraper/pricing-utilization.test.mjs \
    src/modules/market-scraper/market-vendor.test.mjs \
    src/modules/market-scraper/market-scrape-comparison.test.mjs >/dev/null 2>&1 ) \
  && echo "market tests OK" || { echo "ABORT: market tests fallaron (corre el bloque a mano para ver el detalle)." >&2; exit 1; }
echo "Guards OK. (Frontend lo valida el 'next build' del docker build.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market): utilization-based dynamic pricing Fase 2

Per-location utilization tiers adjust the suggested price ON TOP of the base margin,
using projected utilization at pickup. pricing-utilization.js reuses the Availability
Forecast report's computeData for exact parity (reserved/capacity, confirmed-set, per
location), plus pure pickUtilizationTier/applyUtilizationAdjustment (6 tests). The tier
nudges the target all-in before the gross-up→base conversion. MarketPricingConfig gains
utilizationRules JSONB ([{maxPct, adjustAmount?|adjustPct?}]), edited from Settings as a
'maxPct: adjust' ladder. Exports gain a 'Util %' column. Opt-in (only with a config AND
rules); legacy/no-rules unchanged. autoApply NOT enabled — smoke first. Additive
migration. No charge logic touched."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend+frontend → force-recreate → MIGRAR (5432, no pgbouncer)."
