#!/usr/bin/env bash
# Fix MONEY (parte 2): la RAMA 3 de start-rental también preserva los cargos agreement-only.
#   bash .deploy-notes/2026-07-10-ship-agreement-charge-preserve-branch3.sh
#
# CONTEXTO: beta.292 arregló las ramas 1 y 2 de startFromReservation (carve-out + delegación a
# syncAgreementCharges), pero dejó la RAMA 3 (path de cargos SINTETIZADOS, ~:2413) con deleteMany
# INCONDICIONAL. La rama 3 corre cuando la reserva NO tiene ReservationCharge seleccionados
# (reservas de staff/importadas/snapshot). start-rental se dispara con Print/Email Agreement Y con
# GET /reservations/:id/agreement (que la página hace al cargar), así que en esas reservas el misc/
# damage charge DESAPARECÍA al refrescar y no llegaba al contrato, y el void luego daba 404.
#
# FIX (solo rama 3, rental-agreements.service.js ~:2413):
#   - deleteMany con carve-out — pero OJO: las filas sintéticas tienen source NULL, y en Postgres
#     `NULL <> 'X'` = NULL, así que el triple-NOT solo las dejaría vivas y DUPLICARÍA Daily/Tax.
#     El predicado es OR:[ {source:null}, {AND:[triple-NOT]} ] → borra las sintéticas (null) y las
#     no-preservadas, y CONSERVA FEE_ENGINE_*/ADMIN_CORRECTION/DAMAGE_CHARGE.
#   - Totales recomputados desde el SET COMPLETO persistido (sintéticas + preservadas) con el mismo
#     bucketing que syncAgreementCharges (TAX→taxes, FEE_ENGINE→fees, depósito excluido, resto→
#     subtotal; total=subtotal+taxes+fees; balance=max(0,total-paid)). NO se delega a
#     syncAgreementCharges aquí (re-mirror-earía desde reservation.charges VACÍO y borraría las
#     líneas diarias/tax → agreement en cero). Todo dentro de un $transaction. Cada fila 1 sola vez.
#   - Ramas 1/2, addManualCharge, voidAgreementCharge, getPricing y el carve-out de
#     syncAgreementCharges: SIN tocar.
#
# TEST NUEVO (fuerza la rama 3 — lo que el test anterior no hacía): reserva con CERO ReservationCharge,
# añade ADMIN_CORRECTION y DAMAGE_CHARGE, corre startFromReservation, y verifica: la fila sobrevive
# (1 sola vez), Daily/Tax se recrean (1 c/u, no doblados), total/balance la incluyen una vez (no cero,
# no doble), y sigue voidable. rental-agreements 28 verdes; report-damage/void/toll/incident/reservations/
# cache/scope sin regresión.
#
# SIN migración. DEPLOY (BACKEND + WORKER; frontend sin cambio pero rebuild seguro):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#
# SMOKE en prod: en una reserva SIN charges mirrored (staff/importada), añade un misc charge →
# REFRESH la página → debe SEGUIR ahí → Print Agreement → sale en el contrato con balance correcto →
# void funciona. (Antes desaparecía al refrescar.)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.293}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/rental-agreements/start-from-reservation-branch3-preserves-manual-charges.test.mjs"
  "backend/package.json"
  ".deploy-notes/2026-07-10-ship-agreement-charge-preserve-branch3.sh"
)

# ── SANITY GATES ──  (tests DB-backed → validados; gate local sin DB)
node --check backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: node --check rental-agreements" >&2; exit 1; }
grep -q "branch3-preserves-manual-charges" backend/package.json || { echo "ABORT: el test de rama 3 no está en package.json" >&2; exit 1; }
# el carve-out con source:null está presente (el detalle que evita duplicar Daily/Tax)
grep -q "source: null" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: falta el predicado source:null en el carve-out de la rama 3" >&2; exit 1; }
grep -q "ADMIN_CORRECTION" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: falta ADMIN_CORRECTION en el carve-out" >&2; exit 1; }
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK (test rama 3 valida el caso exacto de Hector)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(agreements): start-rental branch 3 preserves agreement-only misc/damage charges (MONEY)

beta.292 carved out branches 1/2 of startFromReservation but left branch 3 (the
synthesized-charges path, run when the reservation has NO selected ReservationCharge
rows — staff/imported/snapshot pricing) with an unconditional deleteMany. That path is
hit by Print/Email Agreement AND by GET /reservations/:id/agreement (page-load), so the
misc (ADMIN_CORRECTION) / damage (DAMAGE_CHARGE) charge vanished on refresh, never reached
the contract, and the later void 404'd. Fix: branch-3 deleteMany now preserves
FEE_ENGINE_*/ADMIN_CORRECTION/DAMAGE_CHARGE via OR:[{source:null},{AND:[triple-NOT]}] — the
source:null clause is required because synthesized rows have a NULL source and Postgres
NULL<>'X' is NULL, so a plain triple-NOT would leave them and DOUBLE the Daily/Tax. Totals
are recomputed from the full persisted set (synthesized + preserved) with the exact
syncAgreementCharges bucketing (no delegation here — it would zero the synthesized rows),
all inside one transaction, each row counted once. Branches 1/2, addManualCharge,
voidAgreementCharge, getPricing untouched. New test forces branch 3 and asserts survival +
single-count + voidability. rental-agreements 28 green; no regressions. No migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend worker frontend -> recreate."
