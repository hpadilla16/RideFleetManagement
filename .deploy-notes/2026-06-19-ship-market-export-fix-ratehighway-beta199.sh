#!/usr/bin/env bash
# v0.9.0-beta.199 — Market Intelligence Excel export: fix 500 + formato estilo RateHighway.
#   bash .deploy-notes/2026-06-19-ship-market-export-fix-ratehighway-beta199.sh
#
# Backend, code-only, SIN migración. ZERO money code (export de solo-lectura; no toca rates ni cobros).
#
# QUE ENTRA:
#   1) FIX del 500 en GET /api/market/export.xlsx (Sentry JAVASCRIPT-NEXTJSBACKEND-22).
#      buildAirportExportWorkbook hacía `where: { ..., runId: { not: null } }` y el Prisma de prod
#      rechaza `{ not: null }` en un campo String → "Argument `not` must not be null". Cambiado a la
#      forma universal `NOT: { runId: null }`. (El dashboard MI usaba este export → daba Internal
#      Server Error al exportar.)
#   2) Formato estilo RateHighway en buildRunComparisonWorkbook (lo usan AMBOS exports: el del
#      airport y el por-run). Nueva PRIMERA hoja "Pricing recommendations" — una fila por
#      (día de pickup × clase SIPP) con columnas: Pick-up · Location · Car Type · Rate Code ·
#      Rule · Comp. Vendor · Comp. Rate · Suggested · Current Rate · Difference · Samples.
#      "Rule" humaniza la estrategia del profile (CHEAPEST_MINUS_AMOUNT→"Lowest - $1",
#      MATCH_CHEAPEST→"Match lowest", CHEAPEST_PLUS_PCT→"Lowest + N%", STATIC_FLOOR→"Floor $N").
#      "Location" sale del profile.locationCode. Las dos hojas pivote (Suggested by class & day,
#      Market cheapest) quedan como hojas de apoyo después de la flat.
#
# Verificado en esta sesión: node --check OK en ambos archivos; `node --test market-scrape-
# comparison.test.mjs` → 17/17 pass; smoke real del workbook (prisma mockeado) genera el .xlsx con
# la hoja "Pricing recommendations" y el layout correcto (suggested = cheapest - $1).
#
# Deploy: build BACKEND + force-recreate. SIN migración, SIN env nuevas.
#
# FILES:
#   backend/src/modules/market-observations/market-observations.service.js
#   backend/src/modules/market-scraper/market-scrape-comparison.service.js
#   .deploy-notes/2026-06-19-ship-market-export-fix-ratehighway-beta199.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.199"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/market-observations/market-observations.service.js"
  "backend/src/modules/market-scraper/market-scrape-comparison.service.js"
  ".deploy-notes/2026-06-19-ship-market-export-fix-ratehighway-beta199.sh"
)

# ── BOOT-SAFETY / SANITY GATES ──
for f in \
  backend/src/modules/market-observations/market-observations.service.js \
  backend/src/modules/market-scraper/market-scrape-comparison.service.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
# El fix del 500: el patrón roto NO debe seguir presente en CÓDIGO (ignorando comentarios //),
# y el bueno SÍ.
grep -vE '^\s*//' backend/src/modules/market-observations/market-observations.service.js \
  | grep -q "runId: { not: null }" \
  && { echo "ABORT: todavía está el patrón roto runId:{not:null} en código." >&2; exit 1; } || true
grep -q "NOT: { runId: null }" backend/src/modules/market-observations/market-observations.service.js \
  || { echo "ABORT: falta el fix NOT:{runId:null}." >&2; exit 1; }
# La hoja RateHighway nueva.
grep -q "Pricing recommendations" backend/src/modules/market-scraper/market-scrape-comparison.service.js \
  || { echo "ABORT: falta la hoja 'Pricing recommendations'." >&2; exit 1; }
# Test del comparison.
( cd backend && node --test src/modules/market-scraper/market-scrape-comparison.test.mjs >/dev/null 2>&1 ) \
  && echo "comparison tests OK" || { echo "ABORT: comparison tests fallaron." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(market): export.xlsx 500 (prisma not:null) + RateHighway-style sheet

GET /api/market/export.xlsx 500'd because buildAirportExportWorkbook used
\`runId: { not: null }\`, which the prod Prisma client rejects on a nullable String
field (\"Argument \`not\` must not be null\", Sentry JAVASCRIPT-NEXTJSBACKEND-22).
Switched to the version-safe \`NOT: { runId: null }\`.

Reworked buildRunComparisonWorkbook (used by both the airport and per-run exports)
to lead with a flat RateHighway-style sheet 'Pricing recommendations': one row per
(pickup day x SIPP) with Pick-up, Location, Car Type, Rate Code, Rule, Comp. Vendor,
Comp. Rate, Suggested, Current Rate, Difference, Samples. Rule humanizes the profile
strategy; Location comes from profile.locationCode. Pivot sheets kept as supporting
views. Read-only export, no migration, zero money code."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. En el droplet: build backend → force-recreate. Sin migración."
