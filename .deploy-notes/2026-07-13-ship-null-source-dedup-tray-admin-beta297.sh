#!/usr/bin/env bash
# MONEY-FIX: charges duplicados por filas null-source (RES-213665) + bandeja de
# imports visible para ADMIN del tenant.
#   bash .deploy-notes/2026-07-13-ship-null-source-dedup-tray-admin-beta297.sh
#
# BUG (Hector, 2026-07-13): RES-213665 mostraba unpaid $120.73 con cargos de $28.97 —
# el agreement tenía DOS Daily y DOS Tax. CAUSA: filas espejo legacy con source:null
# sobreviven el deleteMany de los re-sync (los filtros de string NEGADOS de
# Prisma/Postgres nunca matchean NULL) → cada Print/Email Agreement o recompute
# añadía un espejo nuevo junto al viejo. El branch 3 de startFromReservation YA
# tenía el predicado NULL-safe (beta.293, con comentario del bug); los otros DOS
# writers no. 23 agreements inflados en prod.
#
# FIX (predicado NULL-safe `OR: [{source:null}, {AND:[...carve-outs...]}]`):
# - reservation-pricing.service.js  syncAgreementCharges
# - rental-agreements.service.js    startFromReservation branches 1 y 2
#   (paridad total con el branch 3; carve-outs FEE_ENGINE_/ADMIN_CORRECTION/
#   DAMAGE_CHARGE intactos)
# + test DB-backed null-source-charge-dedup.test.mjs (3/3, reproduce RES-213665)
#   wired en test:rental-agreements.
#
# BANDEJA (decisión Hector): PendingFranchiseImportsTray visible para ADMIN del
# tenant (antes solo SUPER_ADMIN; el backend siempre permitió ADMIN hard-scoped).
# Verificado E2E en dev con user ADMIN real.
#
# DATA-REPAIR APLICADO APARTE EN PROD (no es parte del tag): 22 de los 23
# agreements inflados reparados vía SQL (delete espejo stale + recreate desde la
# reserva + recompute canónico; 167 filas borradas, 95 recreadas; RES-213665 →
# balance $0.00). RES-759253 EXCLUIDO a propósito — Hector verifica su daily
# ($240.95/día en reserva Zezgo) antes de tocarlo.
#
# PIPELINE: diagnóstico con data prod (Supabase MCP) · aprobación explícita de
# Hector (fix + repair + bundle) · QA SHIP.
#
# SIN migración. DEPLOY (BACKEND + FRONTEND):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#
# SMOKE en prod (Hector): RES-213665 → charges $28.97, unpaid $0.00, UN solo Daily;
# Print Agreement en cualquier rental NO duplica líneas; un ADMIN del tenant ve la
# bandeja "Pending franchise imports" en /reservations cuando hay pendientes.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.297}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/rental-agreements/null-source-charge-dedup.test.mjs"
  "backend/package.json"
  "frontend/src/components/reservations/PendingFranchiseImportsTray.jsx"
  ".deploy-notes/2026-07-13-ship-null-source-dedup-tray-admin-beta297.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: node --check pricing" >&2; exit 1; }
node --check backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: node --check agreements" >&2; exit 1; }
# Los 3 writers deben tener el predicado NULL-safe (el branch 3 ya lo tenía = 4 en total con este grep amplio)
NS_COUNT=$(grep -c "source: null" backend/src/modules/rental-agreements/rental-agreements.service.js || true)
[ "$NS_COUNT" -ge 3 ] || { echo "ABORT: faltan predicados null-safe en rental-agreements ($NS_COUNT)" >&2; exit 1; }
grep -q "source: null" backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: falta null-safe en pricing sync" >&2; exit 1; }
grep -q "null-source-charge-dedup.test.mjs" backend/package.json || { echo "ABORT: test no wired" >&2; exit 1; }
grep -q "canSeeTray" frontend/src/components/reservations/PendingFranchiseImportsTray.jsx || { echo "ABORT: tray sin gate de admin" >&2; exit 1; }
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK. (Los tests DB-backed corren en CI/tenant-isolation-suite; localmente validados 34/34.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(agreements): NULL-safe mirror delete — legacy null-source charges no longer duplicate (MONEY) + franchise-imports tray for tenant admins

Legacy RentalAgreementCharge mirror rows written with source:null survived the
re-sync deleteMany in syncAgreementCharges and startFromReservation branches
1/2 — Prisma/Postgres negated string filters never match NULL — so every
Print/Email Agreement or pricing recompute ADDED a fresh mirror set next to
the surviving legacy set: doubled Daily/TAX rows, doubled totals (RES-213665
showed \$120.73 unpaid on \$28.97 of real charges; 23 agreements affected).
Branch 3 already carried the NULL-safe predicate since beta.293 — this brings
all writers to the identical predicate the code comments require. New
DB-backed regression test reproduces the exact case (null rows purged, single
Daily, FEE_ENGINE carve-out preserved, totals not doubled). Separate prod
data-repair (not in this tag) rebuilt the 22 approved agreements' mirrors and
recomputed totals/balances (RES-759253 deliberately left for Hector's review).

Also: PendingFranchiseImportsTray now renders for tenant ADMINs (Hector's
call) — backend routes always allowed ADMIN hard-scoped to their tenant; only
the tray hid itself. Verified E2E with a real ADMIN user. No migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend worker frontend -> recreate."
