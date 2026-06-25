#!/usr/bin/env bash
# v0.9.0-beta.221 — FIX: X-Tenant-Token no scopeaba las rutas GET públicas.
#   bash .deploy-notes/2026-06-24-ship-public-token-query-scope-fix-beta221.sh
#
# Backend-only, SIN migración. No toca money. Arregla el bug encontrado en el smoke de beta.220.
#
# SÍNTOMA (prod, con token válido): /api/public/booking/bootstrap devolvía la rama no-tenant
# (selectedTenant:null, locations:6 de TODOS los tenants) y /website-fees daba 400. El token
# resolvía bien (token malo → 401) pero el tenant forzado NO llegaba a las rutas.
#
# CAUSA: en prod Express `req.query` es un GETTER que re-parsea la URL en cada acceso, así que
# el `req.query.tenantId = tenant.id` del middleware se perdía antes de llegar al handler (la URL
# no trae tenantId). El path por ?tenantSlug funcionaba solo porque el slug SÍ está en la URL.
# Reproducido localmente con un getter que re-parsea: mutar propiedad → undefined; el fix → OK.
#
# FIX (dos capas):
#   1. middleware/public-tenant-token.js: en vez de mutar propiedades de req.query, instala una
#      PROPIEDAD PROPIA via Object.defineProperty(req,'query',{value:{...,tenantId}}) que hace
#      shadow del getter → el valor forzado persiste hasta el handler. (req.body se sigue mutando;
#      es propiedad propia de body-parser y sí persiste.)
#   2. public-booking.routes.js: helper publicTenantArgs(req) que PREFIERE req.publicTokenTenantId
#      (inmune al getter) y si no hay token cae al ?tenantId/?tenantSlug legacy. Usado en las 4
#      rutas GET del sitio: bootstrap, vehicle-classes, vehicle-classes/:id, website-fees.
#   Garantía doble: aunque defineProperty fallara en algún edge, las rutas scopean por publicTokenTenantId.
#
# Verificado local: node --check de ambos archivos ✅; simulación del getter re-parseante ✅
#   (mutar→undefined reproduce el bug; defineProperty→tenantId forzado correcto).
#
# ── SMOKE POST-DEPLOY (con el token ya generado en beta.220) ──
#   TOKEN='<el token de gen-website-token>'
#   curl -s -H "X-Tenant-Token: $TOKEN" https://ridefleetmanager.com/api/public/booking/bootstrap \
#     | jq '{selectedTenant: .selectedTenant.slug, locations:(.locations|length), tenants:(.tenants|length)}'
#       → selectedTenant: "rent-by-vphmotors", locations: 3 (MAYA/PON/KENN, scopeado), NO 6.
#   curl -s -H "X-Tenant-Token: $TOKEN" https://ridefleetmanager.com/api/public/booking/website-fees | jq '.'
#       → 200 con tenant de VPH (fees: [] es esperado hasta configurar fees displayOnline).
#   curl -s -o /dev/null -w "%{http_code}\n" -H "X-Tenant-Token: WRONG" https://ridefleetmanager.com/api/public/booking/website-fees  # 401
#   curl -s -o /dev/null -w "%{http_code}\n" https://ridefleetmanager.com/api/public/booking/website-fees                              # 400
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout v0.9.0-beta.221
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/src/middleware/public-tenant-token.js
#   backend/src/modules/public-booking/public-booking.routes.js
#   .deploy-notes/2026-06-24-ship-public-token-query-scope-fix-beta221.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.221"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/middleware/public-tenant-token.js"
  "backend/src/modules/public-booking/public-booking.routes.js"
  ".deploy-notes/2026-06-24-ship-public-token-query-scope-fix-beta221.sh"
)

# ── SANITY GATES ──
node --check backend/src/middleware/public-tenant-token.js               || { echo "ABORT: node --check middleware" >&2; exit 1; }
node --check backend/src/modules/public-booking/public-booking.routes.js || { echo "ABORT: node --check routes" >&2; exit 1; }
grep -q "Object.defineProperty(req, 'query'" backend/src/middleware/public-tenant-token.js || { echo "ABORT: falta el defineProperty fix" >&2; exit 1; }
grep -q "function publicTenantArgs" backend/src/modules/public-booking/public-booking.routes.js || { echo "ABORT: falta el helper publicTenantArgs" >&2; exit 1; }
grep -q "req.publicTokenTenantId" backend/src/modules/public-booking/public-booking.routes.js || { echo "ABORT: el helper no lee publicTokenTenantId" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(public-booking): X-Tenant-Token now scopes GET routes (req.query getter)

beta.220 smoke showed the token resolved (bad token -> 401) but bootstrap returned the
no-tenant branch (selectedTenant:null, all 6 locations) and website-fees 400 — the forced
tenantId never reached the handlers. Cause: in prod Express req.query is a getter that
re-parses the URL on each access, so the middleware's req.query.tenantId mutation was lost
(the URL carries no tenantId; the ?tenantSlug path worked only because the slug is in the URL).
Fix, two layers: (1) middleware installs req.query as an OWN data property via
Object.defineProperty (shadows the getter so the forced value persists); (2) public-booking
GET routes read req.publicTokenTenantId via a publicTenantArgs() helper as a guaranteed
fallback. Reproduced the re-parsing-getter failure locally and verified both. Backend-only,
no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → force-recreate backend+worker → re-smoke (selectedTenant=rent-by-vphmotors, locations=3)."
