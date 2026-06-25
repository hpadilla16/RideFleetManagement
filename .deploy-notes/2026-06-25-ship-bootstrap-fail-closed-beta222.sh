#!/usr/bin/env bash
# v0.9.0-beta.222 — Seguridad §5: el bootstrap público FALLA CERRADO sin contexto de tenant.
#   bash .deploy-notes/2026-06-25-ship-bootstrap-fail-closed-beta222.sh
#
# Backend-only, SIN migración. No toca money.
#
# QUÉ / POR QUÉ: GET /api/public/booking/bootstrap SIN X-Tenant-Token y SIN ?tenantSlug
# devolvía la rama no-tenant = el catálogo de TODOS los tenants activos (roster + locations +
# vehicleTypes + listings, ~263KB). Viola el fail-closed de §5 (cualquiera que pegue directo
# al API sin token veía todo). El sitio per-tenant siempre manda token (→ scopeado) y los
# clientes legacy mandan ?tenantSlug (→ scopeado); las únicas páginas que usaban el no-tenant
# branch (/book, /become-a-host) están deprecadas (/book no se usa; become-a-host se mueve a
# app aparte). Así que un bootstrap sin contexto ahora devuelve un payload VACÍO.
#
# CAMBIO:
#   backend/src/modules/booking-engine/booking-engine.service.js
#     getBootstrap(): la rama `if (!tenant)` ya NO hace el fan-out de 5 queries cross-tenant;
#     retorna { tenant:null, tenants:[], locations:[], vehicleTypes:[], carSharingSearchPlaces:[],
#     featuredListings:[], bookingModes:{rental:false,carSharing:false} }. (Bonus: mata el
#     fan-out pesado en hits sin scope.) La rama del tenant (token/slug) queda INTACTA.
#   backend/scripts/tenant-tests/v9-website-token-isolation.mjs
#     + aserción: bootstrap sin token/slug → tenants[] y locations[] vacíos (fail-closed).
#
# ⚠️ CAVEAT car-sharing: esto también vacía featuredListings/carSharingSearchPlaces del
# bootstrap SIN tenant. Si un marketplace de car-sharing consume el bootstrap sin contexto
# para su landing cross-host, avísame y le tallo una excepción (solo car-sharing). Las páginas
# de rental no se afectan (siempre con token o slug).
#
# Verificado local: node --check ✅.
#
# ── SMOKE POST-DEPLOY ──
#   curl -s "https://ridefleetmanager.com/api/public/booking/bootstrap" \
#     | jq '{selectedTenant, tenants:(.tenants|length), locations:(.locations|length), vehicleTypes:(.vehicleTypes|length)}'
#       → selectedTenant:null, tenants:0, locations:0, vehicleTypes:0   (antes: 4/6/33)
#   # Con token sigue scopeado:
#   curl -s -H "X-Tenant-Token: $TOKEN" "https://ridefleetmanager.com/api/public/booking/bootstrap" \
#     | jq '{selectedTenant:.selectedTenant.slug, locations:(.locations|length)}'
#       → rent-by-vphmotors, 3
#   # Con slug legacy sigue scopeado:
#   curl -s "https://ridefleetmanager.com/api/public/booking/bootstrap?tenantSlug=corpus" | jq '.selectedTenant.slug'
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout v0.9.0-beta.222
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/src/modules/booking-engine/booking-engine.service.js
#   backend/scripts/tenant-tests/v9-website-token-isolation.mjs
#   .deploy-notes/2026-06-25-ship-bootstrap-fail-closed-beta222.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.222"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/booking-engine/booking-engine.service.js"
  "backend/scripts/tenant-tests/v9-website-token-isolation.mjs"
  ".deploy-notes/2026-06-25-ship-bootstrap-fail-closed-beta222.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/booking-engine/booking-engine.service.js   || { echo "ABORT: node --check booking-engine" >&2; exit 1; }
node --check backend/scripts/tenant-tests/v9-website-token-isolation.mjs     || { echo "ABORT: node --check v9" >&2; exit 1; }
grep -q "Fail-closed (§5 tenant isolation, 2026-06-25)" backend/src/modules/booking-engine/booking-engine.service.js || { echo "ABORT: falta el fail-closed en getBootstrap" >&2; exit 1; }
# La rama del tenant (scopeada) debe seguir intacta:
grep -q "const \[locations, vehicleTypes, featuredListings, tenants, carSharingSearchPlaces\]" backend/src/modules/booking-engine/booking-engine.service.js || { echo "ABORT: se dañó la rama del tenant" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(public-booking): bootstrap fails closed without tenant context (§5)

GET /api/public/booking/bootstrap with no X-Tenant-Token AND no ?tenantSlug/tenantId returned
the no-tenant branch = every active tenant's catalog (roster + locations + vehicleTypes +
listings, ~263KB), violating §5 fail-closed (any direct unscoped API hit saw all tenants).
The per-tenant site sends the token (scoped) and legacy clients send ?tenantSlug (scoped); the
only consumers of the no-tenant branch (/book, /become-a-host) are deprecated. So an unscoped
bootstrap now returns an empty payload (and skips the heavy 5-query cross-tenant fan-out). The
scoped tenant branch is unchanged. v9 isolation test gains a no-token-empty assertion. Backend
only, no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → force-recreate backend+worker → smoke (bootstrap sin token = vacío; con token = scopeado)."
