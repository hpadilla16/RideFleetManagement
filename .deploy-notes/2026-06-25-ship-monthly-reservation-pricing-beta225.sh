#!/usr/bin/env bash
# v0.9.0-beta.225 — Monthly/Long-Term: el plan ahora fija el precio de la RESERVA (línea única).
#   bash .deploy-notes/2026-06-25-ship-monthly-reservation-pricing-beta225.sh
#
# Backend-only, SIN migración. ⚠️ TOCA BALANCE (money) — Hector revisa diff + smoke + deploy.
#
# SÍNTOMA (mostrado en vivo): reserva con Long-Term Plan de $950/30d, pero el panel cobraba
# Daily 30 × $54.14 = $1,624.20 + tax = Unpaid Balance $1,810.98 (la tarifa diaria estándar, no
# la del plan). El plan ($950) vivía aparte y nunca llegaba al precio de la reserva.
#
# CAUSA: attachPlan creaba el LongTermPlan + el billing cycle, pero NO tocaba el ReservationCharge
# base ("Daily"/BASE_RATE). El agreement YA hacía "Monthly Cycle 1" = cycleRate al finalizar
# (rental-agreements ~2181), pero syncAgreementCharges reconstruye desde el ReservationCharge, que
# seguía en days × dailyRate → pisaba el $950.
#
# FIX (Opción B aprobada por Hector — línea única exacta del monthly rate):
#   long-term.service.js: nuevo helper applyMonthlyPricing(reservationId, cycleRate, scope) que al
#   attachPlan (y al updatePlan cuando cambia cycleRate):
#     - borra el cargo base de la reserva (source BASE_RATE/MONTHLY_CYCLE · code DAILY · name "Daily")
#       y crea UNA línea "Monthly Cycle 1" (chargeType MONTHLY, qty 1, rate=total=cycleRate, source
#       MONTHLY_CYCLE) — NO toca services/fees/insurance;
#     - RECOMPUTA el Sales Tax sobre el nuevo taxable base ($950 → $950×taxRate);
#     - actualiza estimatedTotal (no-deposit, incl. tax);
#     - dispara getPricing (dynamic import → sin circular) para que el agreement/unpaid balance
#       sigan al instante. getPricing/syncAgreementCharges leen del ReservationCharge → todo cuadra.
#   Resultado: panel muestra "Monthly Cycle 1 $950" + "Sales Tax" recomputado; Unpaid Balance ≈
#   $950 + tax (ej. SJU 11.5% → $1,059.25), no $1,810.98.
#
# Verificado local: node --check ✅. Sin import estático circular (reservation-pricing NO importa
# long-term). El base se matchea por name 'Daily'/code 'DAILY'/source BASE_RATE (confirmado en
# booking-engine 1816-1827); NO se matchea por chargeType solo (para no borrar add-ons per-day).
#
# OJO reservas YA existentes: attachPlan no re-corre (plan existe → 409). Para repricar una reserva
# que YA tiene plan, re-guarda el cycleRate (PATCH /api/long-term/plans/:id con {cycleRate}) → dispara
# applyMonthlyPricing. Las reservas monthly NUEVAS salen correctas solas.
#
# ── SMOKE (Hector) ──
#   1. Crea una reserva nueva, pégale un Long-Term Plan (Settings monthly rate ej. $950/30d).
#   2. El panel debe mostrar UNA línea "Monthly Cycle 1 $950.00" + "Sales Tax (X%)" recomputado;
#      Unpaid Balance = $950 + tax (NO 30×daily). Sin doble cargo (no debe quedar "Daily").
#   3. Cambia el cycleRate del plan (updatePlan) → el panel y el balance se actualizan al nuevo monto.
#   4. Verifica al checkout que cobra el monto del plan (el agreement ya usa Monthly Cycle 1).
#   5. (DB opcional) ReservationCharge de la reserva: 1 fila MONTHLY_CYCLE + 1 TAX correcta, sin BASE_RATE.
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout v0.9.0-beta.225
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# (Parte 2 — soporte monthly en New Reservation V2 — va en un ship aparte, frontend.)
#
# FILES:
#   backend/src/modules/long-term/long-term.service.js
#   .deploy-notes/2026-06-25-ship-monthly-reservation-pricing-beta225.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.225"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/long-term/long-term.service.js"
  ".deploy-notes/2026-06-25-ship-monthly-reservation-pricing-beta225.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/long-term/long-term.service.js || { echo "ABORT: node --check long-term.service" >&2; exit 1; }
grep -q "async function applyMonthlyPricing" backend/src/modules/long-term/long-term.service.js || { echo "ABORT: falta applyMonthlyPricing" >&2; exit 1; }
grep -q "name: 'Monthly Cycle 1'" backend/src/modules/long-term/long-term.service.js || { echo "ABORT: falta la línea Monthly Cycle 1" >&2; exit 1; }
grep -q "applyMonthlyPricing(reservation.id, plan.cycleRate" backend/src/modules/long-term/long-term.service.js || { echo "ABORT: attachPlan no llama el reprice" >&2; exit 1; }
grep -q "applyMonthlyPricing(plan.reservationId, data.cycleRate" backend/src/modules/long-term/long-term.service.js || { echo "ABORT: updatePlan no llama el reprice" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(long-term): plan attach reprices the reservation to the monthly rate (Option B)

A reservation with a \$950/30d Long-Term Plan still charged Daily x dailyRate (\$1,624.20+tax) —
the plan never reached the reservation pricing. attachPlan created the plan + billing cycle but
left the base ReservationCharge as days x dailyRate, and syncAgreementCharges rebuilds the
agreement from that. New applyMonthlyPricing() (run on attachPlan and on updatePlan cycleRate
change) replaces the base line with a single 'Monthly Cycle 1' charge = cycleRate (source
MONTHLY_CYCLE, mirroring the finalize hook), recomputes Sales Tax on the new base, updates
estimatedTotal, and triggers getPricing so the agreement/unpaid balance follow. Single exact
monthly line; services/fees/insurance untouched. Backend-only, no migration. Part 2 (monthly in
New Reservation V2) ships separately."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → force-recreate backend+worker. SMOKE en una reserva monthly nueva antes de confiar."
