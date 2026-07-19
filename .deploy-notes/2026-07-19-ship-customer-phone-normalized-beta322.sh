#!/usr/bin/env bash
# v0.9.0-beta.322 (renumerado del beta.314 original tras la colisión de tags del 15-jul) — Customer.phoneNormalized: búsqueda de cliente por teléfono confiable
# (VozIA gap #4 + mejora general del search de la consola).
#   bash .deploy-notes/2026-07-19-ship-customer-phone-normalized-beta322.sh
#
# BACKEND ONLY, CON migración ADITIVA (20260715_customer_phone_normalized:
# ADD COLUMN IF NOT EXISTS "phoneNormalized" + índice trgm GIN, idempotente).
# QA SHIP (0 blocker/major) · Innovation OK (0 must-change; sus 2 should-consider
# aplicados: guard de phone:undefined + umbral >=7 dígitos en el search).
#
# QUÉ: el search de customers es ILIKE substring crudo — un teléfono hablado
# ("7875551234") nunca matcheaba el guardado formateado ("(787) 555-1234").
# Nueva columna derivada solo-dígitos Customer.phoneNormalized, poblada en TODOS
# los writes por una extensión central de Prisma (customerPhoneNormalizeExtension
# en src/lib/customer-phone-normalize.js, aplicada en lib/prisma.js vía $extends —
# cubre los 10 create + 29 update sites sin tocarlos). El search de
# customers.service.js añade un arm: phoneNormalized ILIKE %digits% SOLO cuando el
# query trae >=7 dígitos (evita ruido de "100"/placeholder 0000000000).
# Tests: test:customers-phone (13 unit) + embedded-postgres 6/6 (create/update/
# search real). package.json además completa el wiring de test:flexways con
# flexways-worker.test.mjs (archivo YA tracked de la sesión kiosk — solo faltaba
# la línea del script).
#
# ⚠️ BOOT-CRITICAL: src/lib/customer-phone-normalize.js es import top-level de
# lib/prisma.js → si falta del FILES[], el backend NO bootea. Está en FILES[].
#
# DEPLOY (BACKEND ONLY — frontend se queda como está):
#   git fetch --tags && git checkout v0.9.0-beta.322
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# MIGRACIÓN (puerto de SESIÓN 5432, nunca pgbouncer):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   → debe listar 20260715_customer_phone_normalized como applied.
#
# POST-DEPLOY (una vez, dentro del contenedor backend, mismo truco de 5432):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); node scripts/backfill-customer-phone-normalized.mjs'          # dry-run
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); node scripts/backfill-customer-phone-normalized.mjs --apply'  # aplicar
#   (Idempotente; solo escribe phoneNormalized. Mientras no corra, el search viejo
#   por phone ILIKE sigue igual — cero regresión.)
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.322"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

node --check backend/src/lib/customer-phone-normalize.js
node --check backend/src/lib/prisma.js
node --check backend/src/modules/customers/customers.service.js
node --check backend/scripts/backfill-customer-phone-normalized.mjs

FILES=(
  backend/src/lib/customer-phone-normalize.js
  backend/src/lib/customer-phone-normalize.test.mjs
  backend/src/lib/prisma.js
  backend/src/modules/customers/customers.service.js
  backend/src/modules/customers/customer-phone-normalize.embedded.test.mjs
  backend/prisma/schema.prisma
  backend/prisma/migrations/20260715_customer_phone_normalized/migration.sql
  backend/scripts/backfill-customer-phone-normalized.mjs
  backend/package.json
  .deploy-notes/2026-07-19-ship-customer-phone-normalized-beta322.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git status --short --branch
git commit -m "feat(customers): phoneNormalized derived column for reliable phone search

Customer search was a raw ILIKE substring, so a spoken \"7875551234\" never
matched a stored \"(787) 555-1234\" — broken for VozIA voice lookup and for
staff typing digits. Adds Customer.phoneNormalized (digits-only), derived on
every write by a central Prisma query extension (covers all 39 write sites,
present and future), a pg_trgm GIN index, and a search arm that engages only
for phone-shaped queries (>=7 digits). Additive migration + idempotent
backfill script (dry-run/--apply). Unit 13 + embedded-postgres 6 tests.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
