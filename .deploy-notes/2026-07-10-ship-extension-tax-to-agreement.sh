#!/usr/bin/env bash
# Fix MONEY: las extensiones ahora aplican el tax al AGREEMENT (contrato/balance).
#   bash .deploy-notes/2026-07-10-ship-extension-tax-to-agreement.sh
#
# BUG (Hector): al extender una reserva, el tax de la extensión NO se aplicaba al contrato.
# CAUSA: extendReservation/deleteExtension recalculaban el tax del lado RESERVA (recomputeTaxRow)
# pero NUNCA llamaban a syncAgreementCharges → ni el EXTENSION_RATE ni su tax llegaban a
# RentalAgreement.subtotal/taxes/total/balance (lo que el cliente debe). El panel de pricing lo
# mostraba taxeado, pero el contrato vinculante no. Mismo patrón que ya usa el upsell del kiosk
# (recomputeTaxRow → getPricing → syncAgreementCharges).
#
# FIX (reservation-extend.service.js): importa reservationPricingService y llama
# syncAgreementCharges(reservationId, tenantScope||{}, { allowClosed:true }) tras recomputeTaxRow
# en extendReservation Y en deleteExtension. El EXTENSION_RATE (ReservationCharge taxable:true) y
# la línea TAX reconstruida se espejan al agreement UNA sola vez; delete revierte. allowClosed:true
# reconcilia agreements CLOSED (extensiones post-checkout / late return). Sin import circular
# (reservation-pricing no importa reservation-extend), llamadas fuera de $transaction (ven las
# filas ya commiteadas), sin doble-tax. NO toca recomputeTaxRow / rate source / taxable-base /
# addManualCharge / void / getPricing.
#
# PIPELINE: root-cause + fix + QA SHIP. reservation-extend 39 tests (+3 money: extend suma
# subtotal 350/taxes 40.25/total 390.25 una vez; CLOSED reconcilia; delete revierte a 278.75).
# Sin regresión (incident/scope/cache verdes; suites DB-backed verdes en CI/embedded).
#
# SIN migración. DEPLOY (BACKEND + WORKER; frontend sin cambio pero rebuild seguro):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#
# SMOKE en prod: extiende una reserva → el tax debe aparecer en el contrato/balance (antes no) →
# borra la extensión → el tax y el cargo se revierten del contrato.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.294}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservation-extend.service.js"
  "backend/src/modules/reservations/reservation-extend.test.mjs"
  ".deploy-notes/2026-07-10-ship-extension-tax-to-agreement.sh"
)

# ── SANITY GATES ──  (test DB-backed → validado en QA; gate local sin DB)
node --check backend/src/modules/reservations/reservation-extend.service.js || { echo "ABORT: node --check reservation-extend" >&2; exit 1; }
grep -q "syncAgreementCharges" backend/src/modules/reservations/reservation-extend.service.js || { echo "ABORT: reservation-extend no llama syncAgreementCharges" >&2; exit 1; }
grep -q "allowClosed: true" backend/src/modules/reservations/reservation-extend.service.js || { echo "ABORT: falta allowClosed:true en el reconcile de la extensión" >&2; exit 1; }
grep -q "reservationPricingService" backend/src/modules/reservations/reservation-extend.service.js || { echo "ABORT: falta el import de reservationPricingService" >&2; exit 1; }
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK (money-fix validado en QA: tax de extensión al agreement, exactly-once)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reservations): apply extension tax to the agreement (MONEY)

extendReservation/deleteExtension recomputed the reservation-side TAX row but never
called syncAgreementCharges, so the extension's rate AND its tax never reached the
binding RentalAgreement.subtotal/taxes/total/balance — the customer's owed amount
omitted the extension tax (the pricing panel showed it taxed; the contract did not).
Import reservationPricingService and call syncAgreementCharges(reservationId, scope,
{ allowClosed:true }) after recomputeTaxRow in BOTH extend and delete paths, mirroring
the kiosk-upsell pattern. The EXTENSION_RATE + rebuilt TAX ReservationCharge rows are
reconciled onto the agreement exactly once (no double-tax); delete reverses them;
allowClosed reconciles CLOSED agreements (post-checkout/late-return extensions). No
circular import, calls run after the charge writes commit, taxable-base/rate unchanged.
+3 money tests (agreement taxes/total/balance incl. extension tax once, CLOSED case,
delete reversal). QA: SHIP. No migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend worker frontend -> recreate."
