#!/usr/bin/env bash
# v0.9.0-beta.170 — SunPass sync: ventana MÓVIL (no solo hoy)
#   bash .deploy-notes/2026-06-14-ship-sunpass-rolling-window-beta170.sh
#
# BACKEND-ONLY (tolls.service.js). SIN migración. NO toca matching ni charge math.
#
# POR QUÉ: tras el fix de login (beta.169) el Live-Sync corrió OK pero importó 0. El
#   filtro buscaba SOLO el día de hoy y SunPass postea con varios días de lag (posted
#   date > transaction date) → hoy casi siempre sale vacío. Además sirve para VERIFICAR
#   que el scrape de la tabla parsea: con 14 días debe traer filas (casi todas duplicadas
#   de la carga manual de 708) → si scrapedCount>0, el scrape funciona.
#
# QUÉ ENTRA (tolls.service.js):
#   • _runSunPassSync ahora calcula [startDate=hoy-LOOKBACK, endDate=hoy] (default 14d,
#     env TOLLS_SUNPASS_LOOKBACK_DAYS). Dedup por externalId hace seguro el solape.
#   • sunpassFilterAndSearch(page, startStr, endStr) — setea start y end distintos.
#
# Deploy: build backend + worker + force-recreate. Re-test: Tolls → Provider Setup →
#   Live-Sync de SunPass. Revisar el import run: scrapedCount (cuántas filas vio) +
#   importedCount (nuevas) + duplicateExistingCount.
#   - scrapedCount > 0  → el scrape funciona; el conector está vivo.
#   - scrapedCount == 0 → el rediseño también rompió la página de Activity → hace falta
#     dump de DevTools de la página de transacciones para arreglar filtro/tabla.
#
# FILES:
#   backend/src/modules/tolls/tolls.service.js
#   .deploy-notes/2026-06-14-ship-sunpass-rolling-window-beta170.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.170"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/tolls/tolls.service.js"
  ".deploy-notes/2026-06-14-ship-sunpass-rolling-window-beta170.sh"
)

# ── GATES
node --check backend/src/modules/tolls/tolls.service.js
grep -nq "TOLLS_SUNPASS_LOOKBACK_DAYS" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: lookback window missing." >&2; exit 1; }
grep -nq "sunpassFilterAndSearch(page, startStr, endStr)" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: filter signature not updated." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(tolls): SunPass sync pulls a rolling lookback window, not just today

- SunPass posts transactions with a multi-day lag, so a today-only filter returns
  nothing. Pull [today-14d, today] (env TOLLS_SUNPASS_LOOKBACK_DAYS); dedup by
  externalId keeps the overlap a no-op. sunpassFilterAndSearch takes start+end.
  No matching/charge changes."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy backend+worker, then re-run SunPass Live-Sync and report scrapedCount."
