#!/usr/bin/env bash
# DIAGNOSTIC: por qué el worker saca vehicleAcriss=null en TODAS las reservas Flexways.
#   bash .deploy-notes/2026-07-14-ship-flexways-detail-acriss-diagnostic-beta308.sh
#
# CONTEXTO: las 77 reservas Flexways importadas tienen vehicleAcriss=NULL (todas
# MANUAL_REVIEW). Recon en vivo (sesión de Hector) CONFIRMÓ que:
#   - el endpoint es el mismo modificarReserva.php?idAlquiler=<id>,
#   - el HTML CRUDO del servidor SÍ trae <option value=".." selected>...(ACRISS)</option>
#     (probado en 3 reservas: ICAR/EDAR/IFAR),
#   - y el parse (extractSelectedOptionText + extractAcriss) extrae bien ese markup.
# O sea el worker DEBERÍA sacarlo — pero saca null sistemáticamente. Necesitamos ver
# qué recibe realmente la sesión headless del worker.
#
# CAMBIO (1 archivo backend, SOLO un logger.warn diagnóstico): fetchReservationDetail
# ahora, cuando vehicleAcriss sale null, loggea:
#   htmlLen, hasCbCategoria, catBlockLen, selectedOptionText.
# Con eso distinguimos: (a) no hay select cbCategoria (bounce/página distinta),
# (b) hay select pero SIN opción selected (tema de sesión/priming del detalle),
# (c) hay selected pero el parse falla. Cero cambio de comportamiento.
#
# Tests: test:flexways 34/34. SIN migración. BACKEND+WORKER (el detalle corre en el
# worker). Flexways YA está vivo. DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# SMOKE: en el próximo run (o "Run sync now"), grep worker log:
#   docker logs fleet-worker-prod --since 20m 2>&1 | grep "detail: vehicleAcriss null"
# y reportar htmlLen/hasCbCategoria/catBlockLen/selectedOptionText.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.308}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/integrations/flexways/flexways.service.js"
  ".deploy-notes/2026-07-14-ship-flexways-detail-acriss-diagnostic-beta308.sh"
)

grep -q "detail: vehicleAcriss null" backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: falta el log diagnostico" >&2; exit 1; }
node --check backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: service no parsea" >&2; exit 1; }
echo "Guards OK (log diagnostico presente; parse OK). test:flexways 34/34 verificado."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "chore(flexways): diagnostic log when detail vehicleAcriss is null

All imported Flexways rows have vehicleAcriss=null though a primed browser
session GETs modificarReserva.php WITH the reserved <option selected> (ACRISS
in its text) and the parser extracts it. Log what the worker's headless fetch
actually receives (htmlLen/hasCbCategoria/catBlockLen/selectedOptionText) to
tell a missing-selected-option (session) from a parse miss. No behavior change.

test:flexways 34/34. No migration.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy: build + force-recreate backend worker. Then grep worker log for 'detail: vehicleAcriss null'."
