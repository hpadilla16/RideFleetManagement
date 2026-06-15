#!/usr/bin/env bash
# v0.9.0-beta.172 — SunPass scrape: instrumentación de DEBUG (diagnóstico headless)
#   bash .deploy-notes/2026-06-14-ship-sunpass-scrape-debug-beta172.sh
#
# BACKEND-ONLY (tolls.service.js). SIN migración. NO toca matching/charge math.
#
# POR QUÉ: el Live-Sync corre OK pero scrapedCount=0 aunque la búsqueda manual de Hector
#   sí trae 51 filas → el submit/filtro programático no produce resultados en headless y
#   estamos debuggeando a ciegas. Esto captura QUÉ ve la página headless al momento del
#   scrape (URL, # de tablas, # de tr, headers de cada tabla, valores de los selects del
#   filtro, valores de startDateAll/endDateAll, y un snippet de 700 chars del body) y lo
#   guarda en el metadata del import run (campo .debug). Una corrida y vemos la verdad.
#
# QUÉ ENTRA (tolls.service.js): _runSunPassSync ahora devuelve {pageRows, debug} del
#   withPage y mete `debug` en el metadataJson (path no-rows) y en importMeta (path éxito).
#
# Deploy: build backend + worker + force-recreate. Re-test: Live-Sync de SunPass, luego
#   leer dashboard → importRuns[0].metadata.debug (o autoSync.debug). NO requiere nada del
#   usuario más que correr el sync.
#
# FILES:
#   backend/src/modules/tolls/tolls.service.js
#   .deploy-notes/2026-06-14-ship-sunpass-scrape-debug-beta172.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.172"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/tolls/tolls.service.js"
  ".deploy-notes/2026-06-14-ship-sunpass-scrape-debug-beta172.sh"
)

# ── GATES
node --check backend/src/modules/tolls/tolls.service.js
grep -nq "const { pageRows, debug } = await withPage" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: debug capture missing." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "chore(tolls): capture SunPass headless scrape diagnostics into import run

Surfaces the live page state at scrape time (url, table/row counts, table headers,
filter select + date values, body snippet) into the run metadata so the scrapedCount=0
can be diagnosed without guessing. No matching/charge changes."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy backend+worker, re-run SunPass Live-Sync, then read run metadata.debug."
