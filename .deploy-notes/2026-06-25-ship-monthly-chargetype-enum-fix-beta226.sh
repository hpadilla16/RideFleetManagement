#!/usr/bin/env bash
# v0.9.0-beta.226 — FIX: chargeType 'MONTHLY' no existe en el enum → reventaba el reprice monthly.
#   bash .deploy-notes/2026-06-25-ship-monthly-chargetype-enum-fix-beta226.sh
#
# Backend-only, SIN migración. ⚠️ money (long-term). Sigue/arregla beta.225. Hector revisa + smoke + deploy.
#
# SÍNTOMA (tras beta.225): reserva monthly nueva SEGUÍA con "Daily $1,624.20" — el plan se pegaba
# (existe en LongTermPlan) pero el ReservationCharge no cambiaba (sin fila MONTHLY_CYCLE).
# CAUSA: el enum Prisma `ChargeType` solo tiene UNIT/DAILY/TAX/PERCENT/DEPOSIT — **NO existe MONTHLY**.
# applyMonthlyPricing (beta.225) creaba el cargo con chargeType:'MONTHLY' → Prisma lanza "invalid enum"
# → la función revienta ANTES del deleteMany/create → el Daily queda intacto y attachPlan tira error
# (después de crear el plan, por eso el plan existe pero sin reprice). El mismo bug latente estaba en
# 2 sitios más que también habrían reventado al checkout/billing de un long-term.
# FIX: usar chargeType:'UNIT' (el significado lo lleva source 'MONTHLY_CYCLE' + el name). 3 sitios:
#   long-term.service.js  applyMonthlyPricing  (la línea Monthly Cycle de la reserva)  [beta.225]
#   long-term.service.js  closeNextCycle       (el cargo del próximo ciclo)            [latente]
#   rental-agreements.service.js ~2181         (Monthly Cycle 1 al finalizar checkout) [latente]
#
# Verificado local: node --check de ambos archivos ✅; grep confirma CERO chargeType 'MONTHLY' en src/.
#
# ── Reserva ya atascada (cmqtnv13z... y cualquiera con plan creado pre-226) ──
# attachPlan no re-corre (plan existe → 409). Para repricarla tras deploy, dispara updatePlan con el
# mismo cycleRate (PATCH /api/long-term/plans/:id {cycleRate:950}) → corre applyMonthlyPricing ya fixed.
# O simplemente prueba con una reserva monthly NUEVA (sale correcta sola).
#
# ── SMOKE (Hector) ──
#   1. Crea reserva nueva + Long-Term Plan ($950/30d). El panel debe mostrar UNA línea "Monthly Cycle 1
#      $950.00" + "Sales Tax (X%)" recomputado; Unpaid Balance = $950 + tax (NO 30×daily). Sin "Daily".
#   2. (DB) ReservationCharge de esa reserva: 1 MONTHLY_CYCLE + 1 TAX, sin BASE_RATE/Daily.
#   3. Cambia el cycleRate del plan → panel y balance se actualizan.
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout v0.9.0-beta.226
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/src/modules/long-term/long-term.service.js
#   backend/src/modules/rental-agreements/rental-agreements.service.js
#   .deploy-notes/2026-06-25-ship-monthly-chargetype-enum-fix-beta226.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.226"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/long-term/long-term.service.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  ".deploy-notes/2026-06-25-ship-monthly-chargetype-enum-fix-beta226.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/long-term/long-term.service.js          || { echo "ABORT: node --check long-term" >&2; exit 1; }
node --check backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: node --check rental-agreements" >&2; exit 1; }
if grep -rq "chargeType: 'MONTHLY'" backend/src/; then echo "ABORT: todavía hay chargeType 'MONTHLY' (enum inválido)" >&2; exit 1; fi
grep -q "chargeType: 'UNIT'," backend/src/modules/long-term/long-term.service.js || { echo "ABORT: applyMonthlyPricing no usa UNIT" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(long-term): use valid ChargeType UNIT (no 'MONTHLY' enum) for monthly cycle charges

beta.225's monthly reprice silently failed: applyMonthlyPricing created a ReservationCharge with
chargeType 'MONTHLY', but the Prisma ChargeType enum only has UNIT/DAILY/TAX/PERCENT/DEPOSIT — so
Prisma threw 'invalid enum value', the function aborted before replacing the Daily line, and
attachPlan errored after the plan row was already created (plan exists, no reprice). Same latent
bug in closeNextCycle and rental-agreements finalize (would break long-term billing/checkout). Fix:
chargeType 'UNIT' in all three; the monthly meaning is carried by source MONTHLY_CYCLE + the name.
Backend-only, no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → force-recreate backend+worker. SMOKE: reserva monthly NUEVA → línea única \$950 + tax."
