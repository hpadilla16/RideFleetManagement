#!/usr/bin/env bash
# v0.9.0-beta.200 — Market Intelligence export: cubrir la ventana 7d/14d/30d (curva forward),
# estilo RateHighway por día. Sigue a beta.199 (que arregló el 500 + el formato del export por-run).
#   bash .deploy-notes/2026-06-19-ship-market-export-window-beta200.sh
#
# Backend + frontend, code-only, SIN migración. ZERO money code (export de solo-lectura).
#
# PROBLEMA: el botón "Export Excel" del dashboard de Market Intelligence ignoraba el selector
# 7d/14d/30d y solo bajaba el ÚLTIMO run (un snapshot de un día). Hector quiere que el Excel
# cubra la ventana seleccionada y muestre, tal como RateHighway, una fila por día de pickup.
#
# QUE ENTRA:
#   1) buildAirportExportWorkbook reescrito → reporte de VENTANA FORWARD. Para cada día de pickup
#      en [hoy, hoy+days] y cada clase SIPP: toma la ÚLTIMA cotización por competidor (descarta
#      cotizaciones viejas de un mismo día futuro), elige la más barata, aplica la estrategia del
#      profile dueño → Suggested, y compara con la tarifa propia del tenant (PricingRule.sipp del
#      aeropuerto) → Current Rate + Difference. Una fila por (día × clase). Precio = effectiveDaily
#      (all-in, igual que las cards del dashboard) con fallback al dailyPrice. Hoja primaria
#      "Pricing recommendations" (Pick-up · Location · Car Type · Rate Code · Rule · Comp. Vendor ·
#      Comp. Rate · Suggested · Current Rate · Difference · Samples) + pivote "Cheapest by class & day".
#   2) Route GET /api/market/export.xlsx ahora lee ?days= (7|14|30, clamp 1..60, default 14).
#   3) Frontend /market: el botón de export manda &days=${rangeDays} y nombra el archivo
#      market-pricing-<AIRPORT>-<N>d.xlsx.
#   4) Refactor: ruleLabelFor() extraído y exportado del comparison service (lo usan ambos exports).
#
# Verificado en esta sesión: node --check OK (3 backend files + sintaxis frontend la valida el
# next build); `node --test market-scrape-comparison.test.mjs` → 17/17; smoke real del window
# workbook (prisma mockeado) genera el .xlsx — cubre la ventana, descarta cotización stale, cheapest
# correcto, Suggested = cheapest - $1, Current/Difference desde la tarifa propia.
#
# Deploy: build BACKEND + FRONTEND + force-recreate. SIN migración, SIN env nuevas.
#
# FILES:
#   backend/src/modules/market-observations/market-observations.service.js
#   backend/src/modules/market-observations/market-observations.routes.js
#   backend/src/modules/market-scraper/market-scrape-comparison.service.js
#   frontend/src/app/market/page.js
#   .deploy-notes/2026-06-19-ship-market-export-window-beta200.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.200"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/market-observations/market-observations.service.js"
  "backend/src/modules/market-observations/market-observations.routes.js"
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  "frontend/src/app/market/page.js"
  ".deploy-notes/2026-06-19-ship-market-export-window-beta200.sh"
)

# ── BOOT-SAFETY / SANITY GATES ──
for f in \
  backend/src/modules/market-observations/market-observations.service.js \
  backend/src/modules/market-observations/market-observations.routes.js \
  backend/src/modules/market-scraper/market-scrape-comparison.service.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
# La ventana forward + el param days + el export de la regla.
grep -q "buildAirportExportWorkbook({ airport, days" backend/src/modules/market-observations/market-observations.service.js \
  || { echo "ABORT: buildAirportExportWorkbook no acepta days." >&2; exit 1; }
grep -q "days: req.query.days" backend/src/modules/market-observations/market-observations.routes.js \
  || { echo "ABORT: el route no pasa days." >&2; exit 1; }
grep -q "export function ruleLabelFor" backend/src/modules/market-scraper/market-scrape-comparison.service.js \
  || { echo "ABORT: falta export de ruleLabelFor." >&2; exit 1; }
grep -q "days=\${rangeDays}" frontend/src/app/market/page.js \
  || { echo "ABORT: el frontend no manda days=rangeDays." >&2; exit 1; }
# El fix del 500 de beta.199 NO debe revertirse (en código, ignorando comentarios).
grep -vE '^\s*//' backend/src/modules/market-observations/market-observations.service.js \
  | grep -q "runId: { not: null }" \
  && { echo "ABORT: reapareció el patrón roto runId:{not:null}." >&2; exit 1; } || true
# Test del comparison.
( cd backend && node --test src/modules/market-scraper/market-scrape-comparison.test.mjs >/dev/null 2>&1 ) \
  && echo "comparison tests OK" || { echo "ABORT: comparison tests fallaron." >&2; exit 1; }
echo "Guards OK. (Frontend lo valida el 'next build' del docker build.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market): export.xlsx covers the 7d/14d/30d forward window (RateHighway by day)

The /market dashboard export ignored the range selector and only dumped the latest
run (a single-day snapshot). Reworked buildAirportExportWorkbook into a forward-window
report: for each pickup day in [today, today+days] x SIPP it takes the latest quote per
competitor, picks the cheapest, applies the owning profile's strategy for Suggested, and
compares to the tenant's current rate (PricingRule.sipp at the airport) for Current Rate +
Difference. One row per (day x class), RateHighway-style. Route reads ?days= (7|14|30,
clamp 1..60, default 14); the dashboard export button now sends days=rangeDays and names
the file <airport>-<N>d.xlsx. Extracted/exported ruleLabelFor() shared by both exports.
Read-only, no migration, zero money code."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. En el droplet: build backend + frontend → force-recreate. Sin migración."
