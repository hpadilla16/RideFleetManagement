#!/usr/bin/env bash
# FIX: el sync de Flexways traía 0 contratos — faltaban params en la lista.
#   bash .deploy-notes/2026-07-14-ship-flexways-contract-list-params-beta303.sh
#
# BUG (prod, tras encender Flexways): el worker fetcheaba
#   /Helpers/funcionesAjaxContratos.php?idSede=383&length=-1&start=0
# y el portal devolvía recordsTotal:null (payload vacío) → parsed:0 → 0 pickups,
# aunque el login pasaba (run de 11.7s OK, 0 errores). CAUSA: al endpoint
# DataTables le faltaban los params que seleccionan la tabla de contratos
# abiertos. VERIFICADO LIVE 2026-07-14 (sesión de Hector, fetch same-origin):
#   ...funcionesAjaxContratos.php?tablaActual=3&contratosAbiertos=1&idSede=383&length=-1&start=0
#   → {"recordsTotal":200, data:[{ "0":"485556" (idAlquiler), "2":sede,
#      "3":pickup, "4":devolución, "7":"API", "8":cliente, "10":ref }, ...]}
#
# FIX (2 archivos backend): buildContractListUrl añade tablaActual=3 +
# contratosAbiertos=1 (constantes nuevas CONTRACT_LIST_TABLA_ACTUAL /
# CONTRACT_LIST_CONTRATOS_ABIERTOS, overridable por env FLEXWAYS_CONTRACT_
# TABLA_ACTUAL / _CONTRATOS_ABIERTOS). El column-map del recon quedó CONFIRMADO
# en vivo y sin cambios (col 0=idAlquiler, 3=pickup/Desde, 4=devolución/Hasta —
# cross-check contra fechaHoraDesde/Hasta del detail page). También se validó
# en vivo que GET modificarReserva.php?idAlquiler=<id> carga el detalle (200,
# idAlquiler en página, ACRISS presente) → el detail-fetch de Fase 3.5 es válido.
#
# La integración YA está ENCENDIDA (flag live). Tras este deploy, el próximo tick
# (cada 15 min) baja los ~200 contratos. Los ACRISS aún sin mapear en el tenant
# corpus (EBMN/EBMR/CDMR/DDMR/IDMR/FVMR) caen a MANUAL_REVIEW (fail-safe, elegido
# por Hector); backfill del AcrissCategoryMap = trabajo aparte.
#
# Tests: test:flexways 33/33 (fixture actualizado a la forma real confirmada;
# aserciones de pickup/dropoff intactas). SIN migración. BACKEND (worker+backend).
# DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# SMOKE: en el worker log del próximo run debe verse
#   [flexways] contract list fetched  parsed:>0  afterChannel:>0  afterWindow:>0  recordsTotal:200
# y en la DB, filas ExternalReservation FLEXWAYS (la mayoría promotionStatus
# MANUAL_REVIEW hasta sembrar el ACRISS map). O dale "Run sync now".
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.303}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/integrations/flexways/flexways.constants.js"
  "backend/src/modules/integrations/flexways/flexways.service.js"
  "backend/src/modules/integrations/flexways/flexways.test.mjs"
  ".deploy-notes/2026-07-14-ship-flexways-contract-list-params-beta303.sh"
)

# ── SANITY GATES ──
grep -q "u.searchParams.set('tablaActual'" backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: tablaActual no se setea en la URL" >&2; exit 1; }
grep -q "u.searchParams.set('contratosAbiertos'" backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: contratosAbiertos no se setea en la URL" >&2; exit 1; }
# column map must stay at the live-confirmed pickup=3 / dropoff=4
grep -q "FLEXWAYS_CONTRACT_COL_PICKUP ?? 3" backend/src/modules/integrations/flexways/flexways.constants.js || { echo "ABORT: PICKUP_AT no es col 3" >&2; exit 1; }
grep -q "FLEXWAYS_CONTRACT_COL_DROPOFF ?? 4" backend/src/modules/integrations/flexways/flexways.constants.js || { echo "ABORT: DROPOFF_AT no es col 4" >&2; exit 1; }
node --check backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: service no parsea" >&2; exit 1; }
node --check backend/src/modules/integrations/flexways/flexways.constants.js || { echo "ABORT: constants no parsea" >&2; exit 1; }
echo "Guards OK (tablaActual + contratosAbiertos seteados; pickup=3/dropoff=4; parse OK; test:flexways 33/33 verificado)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(flexways): contract-list needs tablaActual=3 + contratosAbiertos=1 (was fetching 0)

The live sync authenticated fine but funcionesAjaxContratos.php returned an
empty payload (recordsTotal:null, parsed:0) because the DataTables request
lacked the table-selection params. Verified live: adding
tablaActual=3 & contratosAbiertos=1 returns the real open-contracts table
(recordsTotal:200; col 0 = idAlquiler, col 3 = pickup, col 4 = return —
recon column map confirmed against the detail page's fechaHoraDesde/Hasta).
buildContractListUrl now sets both params (env-overridable). No migration.

test:flexways 33/33.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy: build + force-recreate backend worker (no migration). Next 15-min tick imports the ~200 contracts."
