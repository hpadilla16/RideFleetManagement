#!/usr/bin/env bash
# SOLD como opción de status en Edit Vehicle (para todos) + hardening: SOLD excluido
# de TODOS los paths de selección/capacidad donde faltaba.
#   bash .deploy-notes/2026-07-02-ship-vehicle-sold-status.sh
#   (tag: TAG_OVERRIDE=v0.9.0-beta.NNN — default beta.278; verificar último tag remoto antes)
#
# BACKEND + FRONTEND, SIN migración. Pipeline completo: Innovation + Graphic Design OK,
# QA = SHIP (33/33 tests: booking-engine 15, planner 2, loaner 16).
#
# QUÉ (spec Hector 2026-07-02): SOLD seleccionable en el Edit Vehicle modal para todo el mundo.
# El modal del PERFIL ya lo tenía; el de la LISTA /vehicles no (drift). Al ampliar el uso de
# SOLD, Innovation encontró 4 filtros backend escritos ANTES de que existiera SOLD (2026-05-28)
# que seguían con notIn:[IN_MAINTENANCE,OUT_OF_SERVICE] — un carro SOLD contaba como capacidad
# del storefront público (oversell) y aparecía en pickers de loaner/asignación.
#
# CAMBIOS:
#   frontend/src/app/vehicles/page.js — Edit modal (lista): + opción SOLD (paridad con perfil),
#     label "Status", y .surface-note condicional al elegir SOLD ("removes the unit from the
#     effective fleet, the planner and the booking engine...").
#   frontend/src/app/vehicles/[id]/page.js — Edit modal (perfil): title="Status" + misma nota.
#   backend booking-engine.service.js ~1035 — rentalAvailabilityCount: notIn + 'SOLD'
#     (capacidad del quote público; ya era consistente con availability-forecast y pricing-utilization).
#   backend dealership-loaner.service.js ~868 — intake picker: notIn + 'SOLD'.
#   backend public-loaner.service.js ~33 — loanerVehicleWhere: notIn + 'SOLD' (lista pública y
#     reserve() → 409 en selecciones nuevas; agreements existentes intactos).
#   backend reservations.routes.js ~669 — /:id/available-vehicles: notIn + 'SOLD' (la rama
#     OR del vehicleId asignado se mantiene → una reserva con carro ya SOLD sigue resolviendo).
#   backend planner.service.js ~331 — loadPlannerVehicles: status not SOLD (schema: SOLD fuera
#     del planner; también limpia los pools de recomendación).
#
# FOLLOW-UPS anotados por QA (no bloquean): (1) reserva asignada a carro que se marca SOLD
# queda fuera del board del planner (escape: swap vía available-vehicles) — considerar bloquear
# SOLD con reservas activas/futuras; (2) añadir asserts de exclusión SOLD a las suites.
#
# ── SMOKE ──
#   /vehicles → seleccionar unidad → Edit Vehicle → Status = SOLD (nota violeta aparece) → Save
#   → badge SOLD en la lista, KPI de flota efectiva baja, el carro desaparece del planner y
#   del storefront (quote público no lo cuenta). Revertible manualmente por el mismo dropdown.
#
# DEPLOY (BACKEND + FRONTEND, sin migración):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   (hard refresh en el browser tras el frontend)
#
# FILES:
#   frontend/src/app/vehicles/page.js
#   frontend/src/app/vehicles/[id]/page.js
#   backend/src/modules/booking-engine/booking-engine.service.js
#   backend/src/modules/dealership-loaner/dealership-loaner.service.js
#   backend/src/modules/dealership-loaner/public-loaner.service.js
#   backend/src/modules/reservations/reservations.routes.js
#   backend/src/modules/planner/planner.service.js
#   .deploy-notes/2026-07-02-ship-vehicle-sold-status.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.278}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/vehicles/page.js"
  "frontend/src/app/vehicles/[id]/page.js"
  "backend/src/modules/booking-engine/booking-engine.service.js"
  "backend/src/modules/dealership-loaner/dealership-loaner.service.js"
  "backend/src/modules/dealership-loaner/public-loaner.service.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/src/modules/planner/planner.service.js"
  ".deploy-notes/2026-07-02-ship-vehicle-sold-status.sh"
)

# ── SANITY GATES ──
for f in backend/src/modules/booking-engine/booking-engine.service.js \
         backend/src/modules/dealership-loaner/dealership-loaner.service.js \
         backend/src/modules/dealership-loaner/public-loaner.service.js \
         backend/src/modules/reservations/reservations.routes.js \
         backend/src/modules/planner/planner.service.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
grep -q "'SOLD'" backend/src/modules/booking-engine/booking-engine.service.js || { echo "ABORT: booking-engine sin SOLD" >&2; exit 1; }
grep -q "not: 'SOLD'" backend/src/modules/planner/planner.service.js || { echo "ABORT: planner sin filtro SOLD" >&2; exit 1; }
grep -q "'SOLD'" frontend/src/app/vehicles/page.js || { echo "ABORT: lista sin opción SOLD" >&2; exit 1; }
( cd backend && npm run test:booking-engine && npm run test:planner && npm run test:loaner ) || { echo "ABORT: tests fallaron" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(vehicles): SOLD selectable in Edit Vehicle + exclude SOLD everywhere it must be

Adds SOLD to the vehicles-list Edit modal status select (parity with the profile
modal, which already had it) with a Status label and an explanatory note when
selected. Hardening found in review: four selection/capacity queries still used
the pre-SOLD notIn [IN_MAINTENANCE, OUT_OF_SERVICE] filter, so a sold vehicle
counted as public storefront capacity (rentalAvailabilityCount), appeared in the
loaner intake picker, in public loaner options and in /:id/available-vehicles
fallbacks; all four now exclude SOLD (assigned-vehicle OR-branch preserved).
Planner loadPlannerVehicles now filters SOLD per the schema's terminal-status
contract. Reviewed by Innovation + Graphic Design; QA verdict SHIP (33/33 across
booking-engine/planner/loaner suites). Frontend+backend, no migration."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"
echo "Pushed $TAG. Droplet: build backend+frontend → recreate backend worker frontend. Smoke: Edit Vehicle → SOLD."
