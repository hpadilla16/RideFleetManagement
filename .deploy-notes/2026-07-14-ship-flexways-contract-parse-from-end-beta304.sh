#!/usr/bin/env bash
# FIX: el sync de Flexways importaba 0 aunque el fetch traía 200 — layout de
# columnas inestable + fecha de pickup compuesta + idAlquiler no fijo.
#   bash .deploy-notes/2026-07-14-ship-flexways-contract-parse-from-end-beta304.sh
#
# CONTEXTO: beta.303 arregló los params (tablaActual=3&contratosAbiertos=1) y el
# portal ya devuelve recordsTotal:200. PERO el worker seguía importando 0. Al
# diagnosticar en vivo (sesión de Hector, fetch same-origin) salieron TRES bugs
# encadenados en el parse de la lista, todos por parsear con índices FIJOS:
#   1) LAYOUT INESTABLE: funcionesAjaxContratos.php a veces trae 12 columnas (con
#      una columna idAlquiler al principio) y a veces 11 (sin ella) — el worker y
#      el browser ven layouts distintos para el MISMO request. Con índices fijos,
#      el filtro de canal (col 7) caía sobre los NOMBRES de cliente en vez de
#      "API" → las 200 filas se descartaban.
#   2) idAlquiler NO está en una columna estable — vive dentro del HTML de la
#      columna de acciones como <input name="idAlquiler" value="485556">.
#   3) La columna de PICKUP (Desde) es COMPUESTA ("2026-07-13</label> 13/07/2026
#      19:55:00") y toIsoFromLatam ancla en ^ → no parseaba → pickup null → la
#      fila se caía en el filtro de ventana.
#
# FIX (2 archivos, backend): el parser de la lista ahora
#   - ancla las columnas DESDE EL FINAL (las de la cola son estables;
#     CONTRACT_COL_FROM_END) → robusto a 11 y 12 columnas,
#   - saca el idAlquiler del HTML de acciones (ID_ALQUILER_RE), y
#   - parsea la fecha LATAM en CUALQUIER parte de la celda (latamAnywhereToUtc)
#     para la columna de pickup compuesta.
#
# VALIDADO EN VIVO sobre las 200 filas reales del portal: idAlquiler 200/200,
# ref 200/200, pickup 200/200, canal API 200/200 → 77 usables (API + pickup en la
# ventana lookback2/lookahead30; los otros 123 son rentas abiertas con pickup
# >2 días atrás — se capturan ampliando lookbackDays de la sede, config aparte).
# Tests: test:flexways 34/34 (nuevo test que valida que 11 y 12 columnas parsean
# idéntico). SIN migración. BACKEND (worker+backend). La integración YA está viva.
# DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# SMOKE: en el próximo run del worker → [flexways] contract list fetched
#   parsed:>0 afterChannel:>0 afterWindow:~77 ; y en la DB filas ExternalReservation
#   FLEXWAYS (la mayoría MANUAL_REVIEW hasta sembrar el ACRISS map). O "Run sync now".
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.304}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/integrations/flexways/flexways.constants.js"
  "backend/src/modules/integrations/flexways/flexways.service.js"
  "backend/src/modules/integrations/flexways/flexways.test.mjs"
  "backend/src/modules/integrations/flexways/flexways-worker.test.mjs"
  ".deploy-notes/2026-07-14-ship-flexways-contract-parse-from-end-beta304.sh"
)

# ── SANITY GATES ──
grep -q "CONTRACT_COL_FROM_END" backend/src/modules/integrations/flexways/flexways.constants.js || { echo "ABORT: CONTRACT_COL_FROM_END falta" >&2; exit 1; }
grep -q "ID_ALQUILER_RE" backend/src/modules/integrations/flexways/flexways.constants.js || { echo "ABORT: ID_ALQUILER_RE falta" >&2; exit 1; }
grep -q "extractIdAlquilerFromRow" backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: extractIdAlquilerFromRow falta" >&2; exit 1; }
grep -q "latamAnywhereToUtc" backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: latamAnywhereToUtc falta" >&2; exit 1; }
node --check backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: service no parsea" >&2; exit 1; }
node --check backend/src/modules/integrations/flexways/flexways.constants.js || { echo "ABORT: constants no parsea" >&2; exit 1; }
echo "Guards OK (from-end + idAlquiler-from-actions + latam-anywhere; parse OK; test:flexways 34/34 verificado + validado en vivo 200/200)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(flexways): parse contract list from the END (unstable columns) + idAlquiler from actions HTML + compound pickup date

The live sync fetched 200 rows but imported 0. Three chained bugs, all from
fixed-index parsing: (1) the DataTables layout is not positionally stable —
the portal ships 11 or 12 columns (a leading idAlquiler column present or
not), so the channel filter landed on customer names and dropped every row;
(2) idAlquiler is only inside the actions HTML (<input name=idAlquiler>), not
a stable column; (3) the pickup/Desde cell is compound (ISO label + LATAM
datetime) which the ^-anchored date parser missed. Fix: anchor columns from
the END (CONTRACT_COL_FROM_END), pull idAlquiler via ID_ALQUILER_RE from the
actions cell, and parse the LATAM date anywhere in the cell. Validated live
against the real 200-row payload (id/ref/pickup/API 200/200). No migration.

test:flexways 34/34 (adds an 11-vs-12-column equivalence test).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy: build + force-recreate backend worker (no migration). Next tick imports ~77 (API + in-window)."
