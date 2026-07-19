#!/usr/bin/env bash
# Quotes module Fase 1 — módulo nativo de quotes (Q-####) con convert-a-reservación.
#   QUOTES_SHIP_TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-17-ship-quotes-module-fase1.sh
#
# ⚠️ TAG PARAMETRIZADO A PROPÓSITO: la numeración de betas se movió 4 veces en un día
# (313→317) por sesiones concurrentes — se fija al momento del ship, no al escribir.
#
# BACKEND+FRONTEND, CON migración ADITIVA (20260717_quotes_module: 1 enum + 1 tabla
# auto-contenida + índices; sin FKs a propósito — ver comment en schema.prisma).
# Plan aprobado por Hector: doc/quotes-module-plan-2026-07-17.md (TTL 72h · módulo
# `quotes` propio · VozIA crea Y convierte · Q-#### · solo rental).
#
# QUÉ: Quote = estimado GUARDADO y decible por voz, calculado por el MISMO motor del
# sitio público (bookingEngineService.searchRental → tax-aware + revenue pricing),
# snapshot-eado (nunca se recalcula al leer; expiresAt protege al negocio). convert()
# re-chequea disponibilidad y crea la reservación AL PRECIO COTIZADO vía
# reservationsService.create (mismas validaciones del staff create: doNotRent,
# location windows, conflictos). Un quote NUNCA mueve dinero ni holdea inventario.
# GUARDARRAÍL beta.296: los quotes son INTENT — jamás entran a reportes de dinero.
#
# Superficie service-account (VozIA), allowlist: GET preview / GET / GET :id /
# POST / POST :id/convert. cancel = solo humanos. Módulo nuevo 'quotes' en
# module-access (ON admin/ops/agent, OFF hosts, tenant ON).
#
# MIGRACIÓN (puerto de SESIÓN 5432, nunca pgbouncer):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   → debe listar 20260717_quotes_module como applied.
#
# DEPLOY (BACKEND + FRONTEND — QA M1: la UI de /quotes viaja en este mismo ship):
#   git fetch --tags && git checkout $TAG
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   (frontend: hard refresh post-deploy, como siempre)
#
# ENV nueva OPCIONAL: QUOTE_TTL_HOURS (default 72) — añadida a .env.example en este
# ship para que env-diff-check la cache.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${QUOTES_SHIP_TAG:?Set QUOTES_SHIP_TAG=v0.9.0-beta.NNN (next free number) before running}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

node --check backend/src/modules/quotes/quotes.service.js
node --check backend/src/modules/quotes/quotes.routes.js
node --check backend/src/modules/quotes/quote-number.js
node --check backend/src/main.js
node --check backend/src/lib/module-access.js
node --check backend/src/lib/service-account-allowlist.js

FILES=(
  backend/src/modules/quotes/quote-number.js
  backend/src/modules/quotes/quotes.service.js
  backend/src/modules/quotes/quotes.routes.js
  backend/src/modules/quotes/quotes.service.test.mjs
  backend/src/main.js
  backend/src/lib/module-access.js
  backend/src/lib/service-account-allowlist.js
  backend/src/lib/service-account-allowlist.test.mjs
  backend/prisma/schema.prisma
  backend/prisma/migrations/20260717_quotes_module/migration.sql
  backend/package.json
  backend/.env.example
  frontend/src/app/quotes/page.js
  frontend/src/components/AppShell.jsx
  frontend/src/lib/moduleAccess.js
  frontend/src/locales/en.json
  frontend/src/locales/es.json
  doc/quotes-module-plan-2026-07-17.md
  doc/quotes-module-mockups-2026-07-17.html
  .deploy-notes/2026-07-17-ship-quotes-module-fase1.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

# ⚠️ schema.prisma y package.json son ARCHIVOS COMPARTIDOS entre workstreams.
# Este script asume que se corre desde un tree LIMPIO (el branch del worktree de
# quotes, o main tree ya sin WIP ajeno). Si git status muestra hunks ajenos en
# esos 2 archivos: PARAR y stagear quirúrgico (lección beta.315).
git add -- "${FILES[@]}"
git status --short --branch
git commit -m "feat(quotes): native saved quotes (Q-####) with convert-to-reservation + staff UI

A Quote is a saved, speakable price estimate computed by the SAME engine the
public site uses (searchRental: tax-aware + revenue pricing) and snapshotted —
never recomputed on read; expiresAt (default 72h) protects the business.
convert() re-checks availability and creates the reservation AT THE QUOTED
PRICE via reservationsService.create. Quotes never move money, never hold
inventory, and never feed money reports (beta.296 guardrail). New 'quotes'
module toggle; VozIA service account may preview/create/read/convert (cancel
stays human-only). Additive migration, self-contained table.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
