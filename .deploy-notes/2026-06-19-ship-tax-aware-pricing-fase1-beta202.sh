#!/usr/bin/env bash
# v0.9.0-beta.202 — Pricing tax-aware Fase 1: motor gross-up por (tenant, location).
#   bash .deploy-notes/2026-06-19-ship-tax-aware-pricing-fase1-beta202.sh
#
# Backend + frontend, CON migración aditiva. Plan: doc/market-pricing-tax-aware-plan-2026-06-19.md.
#
# ⚠️ NOTA DE DINERO: cambia el SUGGESTED (la base que se subiría). OPT-IN POR LOCATION: una location
#    SIN MarketPricingConfig conserva el comportamiento legacy (sin gross-up). El suggested solo se
#    aplica solo si profile.autoApply === true (default FALSE) — NO se enciende en este ship. Probar
#    con Hector antes de activar autoApply. No toca lógica de cobro/charges.
#
# PROBLEMA: scrapeamos el ALL-IN del competidor pero subimos una BASE; Expedia le suma taxes+fees+
# brokerage. El motor restaba el margen al all-in y lo subía como base → en Titanium (SJU) salíamos
# ~45% más caros. La fórmula correcta back-solea la base: base = (all_in − margen) / grossup(config).
#
# QUE ENTRA:
#   1) pricing-grossup.js (puro, 8 tests): customerAllInFromBase / baseFromCustomerAllIn / grossupFactor.
#      TITANIUM: all_in = base×(1+taxes)×(1+brokerage). AMADEUS: base×(1+brokerage)+base×taxes.
#      Validado contra el ejemplo real de Hector: base 53.69 ↔ all-in 78.67.
#   2) Migración aditiva MarketPricingConfig (tenant, locationCode, connectionType, taxes[], brokeragePct,
#      floorBase, currency) + relación en Tenant.
#   3) computeRunComparison: si hay config para profile.locationCode → cheapest ALL-IN, target=margen
#      sobre all-in, base = target/grossup, clamp al floorBase. Filas ganan suggestedAllIn; el suggested
#      sigue siendo lo que se aplica (ahora la base). Sin config → legacy intacto (17 tests verdes).
#   4) Exports (per-run + window del dashboard): columnas "Comp. Rate (all-in)", "Suggested (all-in)" y
#      "Uploaded Rate (base)" cuando hay config; legacy si no.
#   5) Settings → Market Intelligence → "Tax-aware pricing config (per location)": CRUD por location
#      (switch Amadeus/Titanium, taxes name:pct, brokerage %, floor). Endpoints GET/PUT/DELETE
#      /api/settings/market-pricing-config (ADMIN, tenant-scoped).
#
# Verificado: prisma validate OK; node --check OK; 31/31 tests (grossup+vendor+comparison); smoke real
# del window export con config SJU Titanium → Comp 78.67 / Suggested 77.67 / Uploaded base 53.01 (exacto).
#
# Deploy: build BACKEND + FRONTEND + force-recreate + MIGRACIÓN (additive, 5432).
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260619_market_pricing_config/migration.sql
#   backend/src/modules/market-scraper/pricing-grossup.js
#   backend/src/modules/market-scraper/pricing-grossup.test.mjs
#   backend/src/modules/market-scraper/market-scrape-comparison.service.js
#   backend/src/modules/market-observations/market-observations.service.js
#   backend/src/modules/settings/settings.service.js
#   backend/src/modules/settings/settings.routes.js
#   backend/src/docs/extra-routes.generated.js
#   frontend/src/app/settings/page.js
#   .deploy-notes/2026-06-19-ship-tax-aware-pricing-fase1-beta202.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.202"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260619_market_pricing_config/migration.sql"
  "backend/src/modules/market-scraper/pricing-grossup.js"
  "backend/src/modules/market-scraper/pricing-grossup.test.mjs"
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  "backend/src/modules/market-observations/market-observations.service.js"
  "backend/src/modules/settings/settings.service.js"
  "backend/src/modules/settings/settings.routes.js"
  "backend/src/docs/extra-routes.generated.js"
  "frontend/src/app/settings/page.js"
  ".deploy-notes/2026-06-19-ship-tax-aware-pricing-fase1-beta202.sh"
)

# ── BOOT-SAFETY / SANITY GATES ──
[ -f backend/src/modules/market-scraper/pricing-grossup.js ] || { echo "ABORT: falta pricing-grossup.js" >&2; exit 1; }
[ -f backend/prisma/migrations/20260619_market_pricing_config/migration.sql ] || { echo "ABORT: falta la migración" >&2; exit 1; }
for must in \
  "backend/src/modules/market-scraper/pricing-grossup.js" \
  "backend/prisma/migrations/20260619_market_pricing_config/migration.sql"; do
  printf '%s\n' "${FILES[@]}" | grep -Fqx "$must" || { echo "ABORT: $must no está en FILES[]." >&2; exit 1; }
done
for f in \
  backend/src/modules/market-scraper/pricing-grossup.js \
  backend/src/modules/market-scraper/market-scrape-comparison.service.js \
  backend/src/modules/market-observations/market-observations.service.js \
  backend/src/modules/settings/settings.service.js \
  backend/src/modules/settings/settings.routes.js \
  backend/src/docs/extra-routes.generated.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
grep -q "MarketPricingConfig" backend/prisma/schema.prisma || { echo "ABORT: schema sin MarketPricingConfig." >&2; exit 1; }
grep -q "MarketPricingConfig" backend/prisma/migrations/20260619_market_pricing_config/migration.sql || { echo "ABORT: migración sin la tabla." >&2; exit 1; }
grep -q "baseFromCustomerAllIn" backend/src/modules/market-scraper/market-scrape-comparison.service.js || { echo "ABORT: comparison no usa el gross-up." >&2; exit 1; }
grep -q "market-pricing-config" frontend/src/app/settings/page.js || { echo "ABORT: frontend sin la sección." >&2; exit 1; }
( cd backend && node --test src/modules/market-scraper/pricing-grossup.test.mjs src/modules/market-scraper/market-vendor.test.mjs src/modules/market-scraper/market-scrape-comparison.test.mjs >/dev/null 2>&1 ) \
  && echo "market tests OK" || { echo "ABORT: market tests fallaron." >&2; exit 1; }
echo "Guards OK. (Frontend lo valida el 'next build' del docker build.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market): tax-aware pricing engine Fase 1 (gross-up per tenant/location)

Scrapes the competitor ALL-IN and back-solves the BASE rate to upload, undoing
Expedia taxes + fees + brokerage. New pure pricing-grossup.js (TITANIUM compounding /
AMADEUS additive; 8 tests; matches Hector's 53.69↔78.67). MarketPricingConfig per
(tenant, location) — connectionType, taxes[], brokeragePct, floorBase — edited from
Settings → Market Intelligence (GET/PUT/DELETE /api/settings/market-pricing-config).
computeRunComparison and both Excel exports go tax-aware ONLY when a location config
exists (opt-in; legacy untouched otherwise — 17 comparison tests green), adding
Suggested (all-in) + Uploaded Rate (base) columns and clamping to the per-location
floor. Additive migration. autoApply NOT enabled here — smoke before turning it on.
No charge logic touched."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend+frontend → force-recreate → MIGRAR (5432, no pgbouncer)."
