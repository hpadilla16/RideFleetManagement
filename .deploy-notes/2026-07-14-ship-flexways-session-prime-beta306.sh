#!/usr/bin/env bash
# FIX: la sesión headless del worker recibía payload vacío (recordsTotal:null).
#   bash .deploy-notes/2026-07-14-ship-flexways-session-prime-beta306.sh
#
# BUG (prod, tras beta.303/304): el worker autenticaba OK pero
# funcionesAjaxContratos.php le devolvía recordsTotal:null (0 importados), aunque
# el MISMO request desde el browser de Hector devolvía 200. DIAGNÓSTICO EN VIVO
# (sesión de Hector, red del portal): el endpoint AJAX lee el filtro
# tablaActual/contratosAbiertos/idSede del ESTADO DE SESIÓN server-side, que se
# fija al cargar la PÁGINA listadoCotizaciones.php con esos params en la URL. La
# llamada real de la página al AJAX va SIN params (?&_=timestamp) y aun así trae
# los 200 — porque la sesión ya está primeada. El worker pegaba directo al AJAX
# sin cargar la página → sesión sin ese estado → recordsTotal:null.
#
# FIX (2 archivos backend): fetchContractList() ahora hace un GET de la PÁGINA
# (listadoCotizaciones.php?tablaActual=3&contratosAbiertos=1&idSede=<sede>) ANTES
# del AJAX, para primear el filtro server-side en la sesión (best-effort; el AJAX
# igual re-manda los params y el login-bounce se maneja abajo). Nueva constante
# CONTRACT_LIST_PAGE_PATH (env-overridable). El parser robusto de beta.304 y los
# params de beta.303 quedan igual.
#
# Tests: test:flexways 34/34 (el worker test ahora asela que la página se primea
# ANTES del AJAX). SIN migración. BACKEND (worker+backend). Flexways YA está vivo.
# DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# SMOKE: en el próximo run del worker → [flexways] contract list fetched
#   parsed:~200 afterChannel:~200 afterWindow:~77 recordsTotal:200 (ya NO null),
#   y en la DB ~77 filas ExternalReservation FLEXWAYS (la mayoría MANUAL_REVIEW
#   hasta sembrar el ACRISS map). O "Run sync now".
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.306}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/integrations/flexways/flexways.constants.js"
  "backend/src/modules/integrations/flexways/flexways.service.js"
  "backend/src/modules/integrations/flexways/flexways-worker.test.mjs"
  ".deploy-notes/2026-07-14-ship-flexways-session-prime-beta306.sh"
)

# ── SANITY GATES ──
grep -q "CONTRACT_LIST_PAGE_PATH" backend/src/modules/integrations/flexways/flexways.constants.js || { echo "ABORT: CONTRACT_LIST_PAGE_PATH falta" >&2; exit 1; }
grep -q "buildContractListPageUrl" backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: buildContractListPageUrl falta" >&2; exit 1; }
# the prime must be issued before building the AJAX url inside fetchContractList
node -e '
const s=require("fs").readFileSync("backend/src/modules/integrations/flexways/flexways.service.js","utf8");
const prime=s.indexOf("buildContractListPageUrl(idSede), ua"); // the CALL, not the def
const ajax=s.indexOf("const url = buildContractListUrl(idSede)"); // the CALL, not the def
if(prime<0||ajax<0){console.error("ABORT: falta prime o ajax call");process.exit(1);}
if(prime>ajax){console.error("ABORT: el prime va DESPUES del AJAX");process.exit(1);}
' || exit 1
node --check backend/src/modules/integrations/flexways/flexways.service.js || { echo "ABORT: service no parsea" >&2; exit 1; }
node --check backend/src/modules/integrations/flexways/flexways.constants.js || { echo "ABORT: constants no parsea" >&2; exit 1; }
echo "Guards OK (page prime antes del AJAX; parse OK; test:flexways 34/34 verificado)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(flexways): prime the session by loading the list page before the AJAX

The worker authenticated fine but funcionesAjaxContratos.php returned
recordsTotal:null (0 imported), while the same request from a primed browser
returned 200. The AJAX reads its tablaActual/contratosAbiertos/idSede filter
from server-side SESSION STATE, set by first loading the list PAGE
(listadoCotizaciones.php) with those params. A fresh worker session hit the
AJAX directly, so the state was never set. Fix: GET the list page first to
prime the session, then the AJAX. No migration.

test:flexways 34/34 (worker test asserts the page primes before the AJAX).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy: build + force-recreate backend worker (no migration). Next tick should import ~77."
