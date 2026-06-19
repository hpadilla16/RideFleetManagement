#!/usr/bin/env bash
# v0.9.0-beta.201 — Market Intelligence: higiene del pool de competidores, CONFIGURABLE POR TENANT
# desde la UI (paso 1 del pricing). Reemplaza el approach hardcodeado anterior.
#   bash .deploy-notes/2026-06-19-ship-market-competitor-pool-hygiene-beta201.sh
#
# Backend + frontend, CON migración aditiva. ZERO charge logic.
#
# ⚠️ NOTA DE DINERO: cambia cuál competidor se elige como "más barato" → cambia el SUGGESTED price.
#    Solo se cobra solo si profile.autoApply === true (default FALSE). Review-only salvo que lo
#    actives. No toca lógica de cobro/charges.
#
# PROBLEMA: el scraper guarda el vendor crudo de Expedia → la misma marca aparece duplicada
# ("U-Save"/"U-Save Car Rental", "ACE"/"ACE Rent A Car", "NÜ Car Rentals"/"NU", "Nextcar"/"NextCar")
# y — peor — la marca propia del tenant (ZezGo en SJU) aparece como competidor, así que el motor
# sugería precios basados en sí mismo.
#
# QUE ENTRA:
#   1) NUEVO market-vendor.js (puro): vendorKey() canónica (de-acentúa + remueve sufijos
#      "Car Rental"/"Rent A Car"/etc.), normalizeVendorName(), excludeSetFor()/isExcludedVendor().
#      SIN marcas hardcodeadas — la lista la pone cada tenant. 6 unit tests.
#   2) Migración aditiva: Tenant.marketExcludedVendors JSONB (lista de vendors a excluir por tenant).
#   3) Settings → Market Intelligence → "Excluded competitors": textarea por tenant (1 vendor por
#      línea). Endpoints GET/PUT /api/settings/market-excluded-vendors (ADMIN, tenant-scoped).
#      getMarketExcludedVendors/updateMarketExcludedVendors en settings.service.
#   4) aggregateCheapestBySippDate(observations,{excludeSet}) descarta excluidos + normaliza el
#      vendor elegido. getCompetitorExcludeSet(tenantId) lee Tenant.marketExcludedVendors.
#   5) Aplicado en getMarketSummary, getMarketHistory (forward+history) y el window Excel export.
#
# Sin config → no filtra nada (cada tenant configura su propia lista, incl. su marca). Las variantes
# de spelling se colapsan solas vía vendorKey.
#
# Verificado: prisma validate OK; node --check OK; `node --test market-vendor + comparison` → 23/23;
# smoke per-tenant (tenant con ['ZezGo','Routes'] los excluye en cualquier spelling; tenant sin
# config no filtra) + smoke del window export (ZezGo excluida, U-Save dedupe).
#
# Deploy: build BACKEND + FRONTEND + force-recreate + MIGRACIÓN (additive).
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260619_tenant_market_excluded_vendors/migration.sql
#   backend/src/modules/market-scraper/market-vendor.js
#   backend/src/modules/market-scraper/market-vendor.test.mjs
#   backend/src/modules/market-scraper/market-scrape-comparison.service.js
#   backend/src/modules/market-observations/market-observations.service.js
#   backend/src/modules/settings/settings.service.js
#   backend/src/modules/settings/settings.routes.js
#   backend/src/docs/extra-routes.generated.js
#   frontend/src/app/settings/page.js
#   .deploy-notes/2026-06-19-ship-market-competitor-pool-hygiene-beta201.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.201"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260619_tenant_market_excluded_vendors/migration.sql"
  "backend/src/modules/market-scraper/market-vendor.js"
  "backend/src/modules/market-scraper/market-vendor.test.mjs"
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  "backend/src/modules/market-observations/market-observations.service.js"
  "backend/src/modules/settings/settings.service.js"
  "backend/src/modules/settings/settings.routes.js"
  "backend/src/docs/extra-routes.generated.js"
  "frontend/src/app/settings/page.js"
  ".deploy-notes/2026-06-19-ship-market-competitor-pool-hygiene-beta201.sh"
)

# ── BOOT-SAFETY / SANITY GATES ──
[ -f backend/src/modules/market-scraper/market-vendor.js ] || { echo "ABORT: falta market-vendor.js" >&2; exit 1; }
[ -f backend/prisma/migrations/20260619_tenant_market_excluded_vendors/migration.sql ] || { echo "ABORT: falta la migración" >&2; exit 1; }
for must in \
  "backend/src/modules/market-scraper/market-vendor.js" \
  "backend/prisma/migrations/20260619_tenant_market_excluded_vendors/migration.sql"; do
  printf '%s\n' "${FILES[@]}" | grep -Fqx "$must" || { echo "ABORT: $must no está en FILES[]." >&2; exit 1; }
done
for f in \
  backend/src/modules/market-scraper/market-vendor.js \
  backend/src/modules/market-scraper/market-scrape-comparison.service.js \
  backend/src/modules/market-observations/market-observations.service.js \
  backend/src/modules/settings/settings.service.js \
  backend/src/modules/settings/settings.routes.js \
  backend/src/docs/extra-routes.generated.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
# Schema + wiring sanity.
grep -q "marketExcludedVendors" backend/prisma/schema.prisma || { echo "ABORT: schema sin marketExcludedVendors." >&2; exit 1; }
grep -q "marketExcludedVendors" backend/prisma/migrations/20260619_tenant_market_excluded_vendors/migration.sql || { echo "ABORT: migración sin la columna." >&2; exit 1; }
grep -q "getMarketExcludedVendors" backend/src/modules/settings/settings.service.js || { echo "ABORT: falta getMarketExcludedVendors." >&2; exit 1; }
grep -q "market-excluded-vendors" backend/src/modules/settings/settings.routes.js || { echo "ABORT: falta la ruta." >&2; exit 1; }
grep -q "marketExcludedVendors" backend/src/modules/market-scraper/market-scrape-comparison.service.js || { echo "ABORT: getCompetitorExcludeSet no lee el tenant." >&2; exit 1; }
grep -q "market-excluded-vendors" frontend/src/app/settings/page.js || { echo "ABORT: frontend sin la sección." >&2; exit 1; }
# Tests.
( cd backend && node --test src/modules/market-scraper/market-vendor.test.mjs src/modules/market-scraper/market-scrape-comparison.test.mjs >/dev/null 2>&1 ) \
  && echo "market tests OK" || { echo "ABORT: market tests fallaron." >&2; exit 1; }
echo "Guards OK. (Frontend lo valida el 'next build' del docker build.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market): per-tenant competitor-pool hygiene (own-brand exclude + vendor normalize)

Configurable from Settings → Market Intelligence → 'Excluded competitors' (one vendor
per line) and stored on Tenant.marketExcludedVendors — each tenant lists its own
brand(s) + any vendors to drop from the pool. New pure market-vendor.js (vendorKey,
normalizeVendorName, exclude set; 6 tests) collapses spelling variants
(U-Save / U-Save Car Rental, NÜ / NU). aggregateCheapestBySippDate drops excluded
vendors and normalizes the chosen name; getCompetitorExcludeSet reads the tenant
config (no hardcoded brands). Applied across getMarketSummary, getMarketHistory and
the window Excel export. Additive migration (Tenant.marketExcludedVendors JSONB).
Affects the SUGGESTED price (review-only unless profile.autoApply); no charge logic."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend+frontend → force-recreate → MIGRAR (5432, no pgbouncer)."
