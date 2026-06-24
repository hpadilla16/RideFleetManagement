#!/usr/bin/env bash
# v0.9.0-beta.215 — Fix Admin Corrections: void/add operaban sobre el set de cargos equivocado.
#   bash .deploy-notes/2026-06-23-ship-admin-corrections-charge-source-fix-beta215.sh
#
# Backend + Frontend, SIN migración. MONEY-adjacent (cargos/balance) — Hector revisa + smoke + deploy.
#
# BUG (beta.213/214): el panel listaba `pricing.charges` = **ReservationCharge** (el estimado),
# pero Void/Add operan sobre **RentalAgreementCharge** (el del agreement, donde viven los
# post-check-in fees del fee-engine). Los IDs son de sets distintos →
#   - Void → buscaba un RentalAgreementCharge por un id de ReservationCharge → "no encuentra ese precio".
#   - Add  → SÍ creaba el RentalAgreementCharge, pero el panel re-leía ReservationCharge → no lo veía
#            ("no se añade").
#   - Los fuel/cleaning/smoking/late fees (solo RentalAgreementCharge) ni aparecían para anular.
#
# FIX: nuevo endpoint que devuelve los RentalAgreementCharge reales (ids correctos + post-check-in
# fees) y el panel los usa en vez de /pricing. Así el set listado == el set sobre el que opera Void/Add.
#
# CAMBIOS:
#   backend/src/modules/reservations/reservation-pricing.service.js
#     + reservationPricingService.listAgreementCharges(reservationId, scope)
#       → { charges:[{id,name,total,source,chargeType,taxable}], balance, total } (RentalAgreementCharge, selected=true)
#   backend/src/modules/reservations/reservations.routes.js
#     + GET /api/reservations/:id/agreement-charges  (ADMIN, gate canDoAdminCorrections)
#   frontend/src/app/reservations/[id]/page.js
#     - AdminCorrectionsPanel: loadPricing() ahora pega a /agreement-charges (no /pricing)
#     + muestra "Agreement balance" en el panel
#
# Verificado local: node --check de los 2 backend ✅; esbuild parse del page.js ✅.
#
# DEPLOY (BACKEND + FRONTEND):
#   git fetch --tags && git checkout v0.9.0-beta.215
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend frontend
#   # Sin migración. HARD REFRESH después.
#
# SMOKE (en reserva de prueba con un fuel/smoking fee):
#   1. Panel ⚙️ Admin Corrections → Show → ahora la lista incluye los post-check-in fees.
#   2. Void de un fee → SIN error, balance baja exacto, el fee desaparece de la lista.
#   3. Add credit -$25 / charge $15 → aparece en la lista al instante y el balance se mueve.
#
# FILES:
#   backend/src/modules/reservations/reservation-pricing.service.js
#   backend/src/modules/reservations/reservations.routes.js
#   frontend/src/app/reservations/[id]/page.js
#   .deploy-notes/2026-06-23-ship-admin-corrections-charge-source-fix-beta215.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.215"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "frontend/src/app/reservations/[id]/page.js"
  ".deploy-notes/2026-06-23-ship-admin-corrections-charge-source-fix-beta215.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: node --check service" >&2; exit 1; }
node --check backend/src/modules/reservations/reservations.routes.js          || { echo "ABORT: node --check routes" >&2; exit 1; }
grep -q "async listAgreementCharges" backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: falta listAgreementCharges" >&2; exit 1; }
grep -q "/:id/agreement-charges" backend/src/modules/reservations/reservations.routes.js || { echo "ABORT: falta la ruta GET agreement-charges" >&2; exit 1; }
grep -q "agreement-charges" "frontend/src/app/reservations/[id]/page.js" || { echo "ABORT: el panel no usa el endpoint nuevo" >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reservations): Admin Corrections list RentalAgreementCharge, not ReservationCharge

The panel listed pricing.charges (ReservationCharge — the estimate) but void/add operate
on RentalAgreementCharge (the agreement, where post-check-in fees live). Different ids →
void failed with 'charge not found' and add didn't reflect (and post-check-in fees never
showed). New GET /:id/agreement-charges returns the RentalAgreementCharge rows; the panel
uses that so the listed set matches what void/add mutate. Shows the agreement balance too.
Backend + frontend; no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND + FRONTEND → force-recreate. Sin migración. HARD REFRESH + smoke."
