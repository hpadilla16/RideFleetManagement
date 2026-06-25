#!/usr/bin/env bash
# v0.9.0-beta.220 — Public booking website X-Tenant-Token scoping (Rent & Go by VPH Motors).
#   bash .deploy-notes/2026-06-24-ship-public-website-token-beta220.sh
#
# Backend-only, CON migración (aditiva). NO toca money. NO toca otros tenants.
# Plan: doc/public-website-token-scoping-plan-2026-06-24.md
#
# QUÉ: el sitio público "Rent & Go by VPH Motors" manda un secreto server-only
# `X-Tenant-Token` en cada request a /api/public/booking/*. El backend resuelve ese token a
# un tenant y FUERZA el scope, fail-closed. SOLO afecta requests con el header — los clientes
# legacy por ?tenantSlug (app Flutter) siguen igual.
#
# SEGURIDAD (clave):
#   - Guardamos SOLO el sha256 del token en Tenant.websiteTokenHash (el claro nunca se persiste;
#     se genera con scripts/gen-website-token.mjs y se pone en el Vercel env del sitio).
#   - Header ausente → next() sin cambios (comportamiento actual por slug).
#   - Header válido → req.query/body.tenantId = ese tenant + se borra cualquier tenantSlug
#     (un caller NO puede pedir otro tenant) → todos los endpoints públicos scopean a ÉL.
#   - Header inválido → 401 (nunca cae a data).
#   - Token presente pero SIN slug → con el scope forzado hay tenant; sin token y sin slug → vacío.
#
# CAMBIOS:
#   backend/prisma/schema.prisma                              + Tenant.websiteTokenHash @unique, companyLogoUrl
#   backend/prisma/migrations/20260624_tenant_website_token/migration.sql   (ADD COLUMN IF NOT EXISTS, idempotente)
#   backend/src/middleware/public-tenant-token.js            NUEVO middleware resolvePublicTenantToken
#   backend/src/main.js                                      monta el middleware antes de los routers /api/public/booking
#   backend/src/modules/public-booking/public-booking.routes.js   + GET /vehicle-classes/:vehicleTypeId (detalle de clase, el rent/:id del sitio)
#   backend/src/modules/booking-engine/booking-engine.service.js  + companyLogoUrl en el tenant del bootstrap (branding del sitio)
#   backend/scripts/gen-website-token.mjs                    NUEVO genera+rota el token (imprime el claro 1 vez)
#   backend/scripts/tenant-tests/v9-website-token-isolation.mjs   NUEVO test de aislamiento del token
#   backend/scripts/tenant-tests/run-suite.mjs               + v9 en la suite
#   doc/public-website-token-scoping-plan-2026-06-24.md
#
# Verificado local: node --check de middleware + main.js + routes + gen + v9 + run-suite ✅;
#   prisma validate ✅.
#
# ── DESPUÉS DEL DEPLOY (Hector) ──
#   1. Migración por el puerto de SESIÓN 5432 (NUNCA pgbouncer 6543):
#      docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#      → verifica: \d "Tenant"  debe mostrar websiteTokenHash + companyLogoUrl.
#   2. Confirma el slug del tenant de VPH/Triangle (el que tiene la flota+locations):
#      docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); node -e "import(\"@prisma/client\").then(async({PrismaClient})=>{const p=new PrismaClient();console.table(await p.tenant.findMany({where:{status:\"ACTIVE\"},select:{slug:true,name:true}}));await p.\$disconnect()})"'
#      → si el slug NO es rent-by-vphmotors, dime y lo ajustamos (o generamos el token con el slug real).
#   3. Genera el token (lo pones en el Vercel env del sitio como TRIANGLE_TENANT_TOKEN):
#      docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); node scripts/gen-website-token.mjs <slug-de-vph>'
#      ⚠️ SE IMPRIME UNA SOLA VEZ — guárdalo. Re-correr ROTA (invalida el anterior).
#   4. (opcional) logo del sitio:
#      UPDATE "Tenant" SET "companyLogoUrl"='https://.../logo.png' WHERE slug='<slug-de-vph>';
#   5. Smoke con el token (debe devolver el tenant de VPH y NADA de otro tenant):
#      curl -s -H "X-Tenant-Token: <token>" https://ridefleetmanager.com/api/public/booking/bootstrap | jq '.tenantId, (.locations|length)'
#      curl -s -H "X-Tenant-Token: WRONG"   https://ridefleetmanager.com/api/public/booking/website-fees -o /dev/null -w "%{http_code}\n"   # → 401
#      curl -s https://ridefleetmanager.com/api/public/booking/website-fees -o /dev/null -w "%{http_code}\n"                                # → 400 (sin token ni slug)
#   6. Suite de aislamiento (incluye v9): API_BASE=https://ridefleetmanager.com/api node scripts/tenant-tests/run-suite.mjs  → 100%.
#
# DEPLOY (BACKEND only):
#   git fetch --tags && git checkout v0.9.0-beta.220
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#   # luego la migración (paso 1 de arriba). Frontend NO cambia.
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260624_tenant_website_token/migration.sql
#   backend/src/middleware/public-tenant-token.js
#   backend/src/main.js
#   backend/src/modules/public-booking/public-booking.routes.js
#   backend/scripts/gen-website-token.mjs
#   backend/scripts/tenant-tests/v9-website-token-isolation.mjs
#   backend/scripts/tenant-tests/run-suite.mjs
#   doc/public-website-token-scoping-plan-2026-06-24.md
#   .deploy-notes/2026-06-24-ship-public-website-token-beta220.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.220"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260624_tenant_website_token/migration.sql"
  "backend/src/middleware/public-tenant-token.js"
  "backend/src/main.js"
  "backend/src/modules/public-booking/public-booking.routes.js"
  "backend/src/modules/booking-engine/booking-engine.service.js"
  "backend/scripts/gen-website-token.mjs"
  "backend/scripts/tenant-tests/v9-website-token-isolation.mjs"
  "backend/scripts/tenant-tests/run-suite.mjs"
  "doc/public-website-token-scoping-plan-2026-06-24.md"
  ".deploy-notes/2026-06-24-ship-public-website-token-beta220.sh"
)

# ── SANITY GATES ──
node --check backend/src/middleware/public-tenant-token.js                  || { echo "ABORT: node --check middleware" >&2; exit 1; }
node --check backend/src/main.js                                            || { echo "ABORT: node --check main.js" >&2; exit 1; }
node --check backend/src/modules/public-booking/public-booking.routes.js    || { echo "ABORT: node --check routes" >&2; exit 1; }
node --check backend/src/modules/booking-engine/booking-engine.service.js   || { echo "ABORT: node --check booking-engine" >&2; exit 1; }
grep -q "companyLogoUrl: tenant.companyLogoUrl" backend/src/modules/booking-engine/booking-engine.service.js || { echo "ABORT: falta companyLogoUrl en bootstrap" >&2; exit 1; }
node --check backend/scripts/gen-website-token.mjs                          || { echo "ABORT: node --check gen script" >&2; exit 1; }
node --check backend/scripts/tenant-tests/v9-website-token-isolation.mjs    || { echo "ABORT: node --check v9" >&2; exit 1; }
node --check backend/scripts/tenant-tests/run-suite.mjs                     || { echo "ABORT: node --check run-suite" >&2; exit 1; }
# main.js DEBE importar y montar el middleware (si falta el import, el backend NO bootea):
grep -q "resolvePublicTenantToken" backend/src/main.js                      || { echo "ABORT: main.js no monta el middleware" >&2; exit 1; }
grep -q "from './middleware/public-tenant-token.js'" backend/src/main.js    || { echo "ABORT: falta el import del middleware en main.js" >&2; exit 1; }
grep -q "websiteTokenHash" backend/prisma/schema.prisma                     || { echo "ABORT: schema sin websiteTokenHash" >&2; exit 1; }
grep -q "vehicle-classes/:vehicleTypeId" backend/src/modules/public-booking/public-booking.routes.js || { echo "ABORT: falta el endpoint detalle de clase" >&2; exit 1; }
grep -q "v9-website-token-isolation" backend/scripts/tenant-tests/run-suite.mjs || { echo "ABORT: v9 no está en la suite" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(public-booking): X-Tenant-Token scoping for the public booking website

The public site (Rent & Go by VPH Motors) sends a server-only X-Tenant-Token on every
/api/public/booking request. New middleware resolvePublicTenantToken hashes the header
(sha256) and resolves it to Tenant.websiteTokenHash; when present+valid it FORCES that
tenant (overwrites req.query/body tenantId, strips tenantSlug) so every public endpoint
scopes to it and a caller can't request another tenant. Absent header → unchanged legacy
?tenantSlug behavior; invalid → 401 (fail-closed). Adds GET
/api/public/booking/vehicle-classes/:vehicleTypeId (class detail, the site's rent/:id),
gen-website-token.mjs (generates+rotates the token, prints plaintext once), and the v9
token-isolation test (added to run-suite). Additive migration (websiteTokenHash @unique,
companyLogoUrl). Backend-only, no money. Plan: doc/public-website-token-scoping-plan-2026-06-24.md"
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → force-recreate backend+worker → migración por 5432 → gen-website-token → smoke."
