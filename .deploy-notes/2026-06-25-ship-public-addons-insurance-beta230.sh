#!/usr/bin/env bash
# v0.9.0-beta.230 — Endpoints públicos: add-ons (AdditionalService) + insurance plans para rental.
#   bash .deploy-notes/2026-06-25-ship-public-addons-insurance-beta230.sh
#
# Backend-only, SIN migración. Read-only público, scoped por X-Tenant-Token (fail-closed). Para el sitio Rent & Go.
#
# QUÉ: dos GET nuevos en /api/public/booking (mismo middleware/scoping que el resto del booking),
# reusando los helpers que YA existían (listPublicAdditionalServices / listPublicInsurancePlans usados
# en searchRental). Solo se EXPONEN.
#   GET /api/public/booking/additional-services?vehicleTypeId=<id>  -> { services: [...] }
#     - AdditionalService isActive + displayOnline del tenant; filtro por vehicleType (allVehicleTypes
#       o vehicleTypeIds contiene el id). Sin vehicleTypeId → todos los online. Orden sortOrder/name.
#     - shape: { id, code, name, description(displayDescription??description), rate, dailyRate|null,
#       chargeType:"PER_DAY"|"PER_RENTAL", unitLabel, mandatory, taxable }
#   GET /api/public/booking/insurance-plans?vehicleTypeId=<id>  -> { plans: [...] }
#     - planes de seguro/protección online del tenant (settingsService.getInsurancePlans + filtro
#       isActive/location/vehicleType). shape: { code, name, description, amount, rate,
#       chargeBy:"PER_DAY"|"FIXED"|"PERCENTAGE", taxable }
#
# CÓMO LO USA EL SITIO: lista add-ons + protección en la página de vehículo; PER_DAY = rate×días,
# PER_RENTAL/FIXED = una vez; mandatory pre-seleccionados. Los IDs/códigos elegidos van en el POST de
# checkout para que RFM calcule el total/impuestos reales.
#
# CAMBIOS (solo exponer; cero lógica de pricing nueva):
#   booking-engine.service.js: + bookingEngineService.getPublicAdditionalServices/getPublicInsurancePlans
#     (resuelven el tenant + llaman los helpers con locationId:null, days:1) + displayDescription en
#     computeAdditionalServiceLine (aditivo).
#   public-booking.service.js: + getAdditionalServices/getInsurancePlans (mapean al shape público).
#   public-booking.routes.js: + GET /additional-services y GET /insurance-plans (bookingReadGuard +
#     publicTenantArgs → fail-closed: sin token → []).
#
# Verificado local: node --check de los 3 archivos ✅.
#
# ── SMOKE / DELIVERABLE (TOKEN='952af2747299acaf26bac0e22a082a16776387ba8b316043882e7ee63be5a5fa') ──
#   # pon un vehicleTypeId real de Rent & Go (de bootstrap.vehicleTypes[].id):
#   curl -s -H "X-Tenant-Token: $TOKEN" "https://ridefleetmanager.com/api/public/booking/additional-services?vehicleTypeId=<VT_ID>" | jq .
#   curl -s -H "X-Tenant-Token: $TOKEN" "https://ridefleetmanager.com/api/public/booking/insurance-plans?vehicleTypeId=<VT_ID>" | jq .
#   # fail-closed (sin token → services/plans vacíos):
#   curl -s "https://ridefleetmanager.com/api/public/booking/additional-services" | jq '.services|length'   # 0
#   → Esos 2 JSON son el entregable. OJO: salen vacíos hasta que el tenant tenga add-ons/planes con
#     displayOnline=true configurados (igual que los fees).
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout v0.9.0-beta.230
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/src/modules/booking-engine/booking-engine.service.js
#   backend/src/modules/public-booking/public-booking.service.js
#   backend/src/modules/public-booking/public-booking.routes.js
#   .deploy-notes/2026-06-25-ship-public-addons-insurance-beta230.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.230"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/booking-engine/booking-engine.service.js"
  "backend/src/modules/public-booking/public-booking.service.js"
  "backend/src/modules/public-booking/public-booking.routes.js"
  ".deploy-notes/2026-06-25-ship-public-addons-insurance-beta230.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/booking-engine/booking-engine.service.js   || { echo "ABORT: node --check booking-engine" >&2; exit 1; }
node --check backend/src/modules/public-booking/public-booking.service.js   || { echo "ABORT: node --check public-booking.service" >&2; exit 1; }
node --check backend/src/modules/public-booking/public-booking.routes.js    || { echo "ABORT: node --check routes" >&2; exit 1; }
grep -q "getPublicAdditionalServices" backend/src/modules/booking-engine/booking-engine.service.js || { echo "ABORT: falta el método add-services" >&2; exit 1; }
grep -q "'/additional-services'" backend/src/modules/public-booking/public-booking.routes.js || { echo "ABORT: falta la ruta additional-services" >&2; exit 1; }
grep -q "'/insurance-plans'" backend/src/modules/public-booking/public-booking.routes.js || { echo "ABORT: falta la ruta insurance-plans" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(public-booking): expose additional-services + insurance-plans endpoints

Two new public GETs on /api/public/booking (X-Tenant-Token scoped, fail-closed) for the website's
'Add extras' and 'Protection' on a vehicle page: GET /additional-services?vehicleTypeId and
GET /insurance-plans?vehicleTypeId. Both reuse the existing helpers (listPublicAdditionalServices /
listPublicInsurancePlans already used in searchRental) — only exposed, no new pricing logic. Add-ons:
isActive+displayOnline, filtered by vehicle type, shape {id,code,name,description,rate,dailyRate,
chargeType,unitLabel,mandatory,taxable}. Insurance: online plans, shape {code,name,description,amount,
rate,chargeBy,taxable}. Added displayDescription to computeAdditionalServiceLine (additive). Selected
ids/codes go in the checkout POST so RFM computes the real total/tax. Backend-only, no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → recreate. Smoke con vehicleTypeId real + token."
