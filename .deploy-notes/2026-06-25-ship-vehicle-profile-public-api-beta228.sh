#!/usr/bin/env bash
# v0.9.0-beta.228 — Vehicle Profile en la API pública (bootstrap + vehicle-classes). Genérico.
#   bash .deploy-notes/2026-06-25-ship-vehicle-profile-public-api-beta228.sh
#
# Backend-only, CON migración (aditiva). No toca money. Read-only público. Para el website Rent & Go.
#
# QUÉ: el VehicleType ahora tiene specs públicas y se exponen en los 2 endpoints que el sitio lee,
# con el MISMO shape de vehicleType en ambos. Genérico para todos los tenants (sigue scopeado por
# X-Tenant-Token). NO incluye rates/unidades por location (eso es aparte).
#
# CAMBIOS:
#   prisma/schema.prisma + migración 20260625_vehicle_profile_public_fields:
#     VehicleType += passengers Int?, bags Int?, doors Int?, transmission enum(AUTOMATIC|MANUAL),
#     features String[] (text[]), unlimitedMileage Bool=false, freeMilesPerDay Int?,
#     insuranceIncluded Bool=false. (imageUrl ya existía.)
#   src/modules/public-booking/vehicle-feature-catalog.js  NUEVO — catálogo controlado de features
#     (AC, BLUETOOTH, CARPLAY, ANDROID_AUTO, GPS, USB, BACKUP_CAM, …) + publicVehicleProfile() que
#     arma el shape { imageUrl, passengers, bags, transmission, doors, features[],
#     included:{ mileage:"UNLIMITED"|{freeMilesPerDay}|null, insuranceIncluded } }.
#   booking-engine.service.js:
#     - getBootstrap (rama tenant): el select de vehicleTypes ahora trae imageUrl + los campos nuevos.
#     - searchRental: el vehicleType del resultado pasa los campos crudos (tenantVehicleTypes ya
#       traía la fila completa).
#   public-booking.service.js:
#     - getBootstrap: vehicleTypes mapea con publicVehicleProfile().
#     - getVehicleClasses (~317): el vehicleType de cada class spread ...publicVehicleProfile().
#
# Verificado local: node --check de los 3 archivos ✅; prisma validate ✅; migración 8× ADD COLUMN IF NOT EXISTS.
#
# ── DESPUÉS DEL DEPLOY (Hector) ──
#   1. Migración por el puerto de SESIÓN 5432 (NUNCA 6543):
#      docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   2. Llena UN VehicleType de Rent & Go para validar (ej. un SUV; valores reales tuyos). Rent & Go
#      = millaje ILIMITADO, seguro NO incluido. features = códigos del catálogo:
#      docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); node -e "import(\"@prisma/client\").then(async({PrismaClient})=>{const p=new PrismaClient();const r=await p.vehicleType.updateMany({where:{tenantId:\"cmqrk8r9w0000s60s4qr9lt3v\",code:\"SSUV\"},data:{passengers:5,bags:3,doors:4,transmission:\"AUTOMATIC\",features:[\"AC\",\"BLUETOOTH\",\"BACKUP_CAM\",\"CARPLAY\"],imageUrl:\"https://REEMPLAZA-con-tu-foto.jpg\",unlimitedMileage:true,insuranceIncluded:false}});console.log(\"updated\",r.count);await p.\$disconnect()})"'
#      (cambia code/valores; imageUrl debe ser URL CDN pequeña, NO base64.)
#   3. Captura el JSON deliverable (con el token):
#      TOKEN='952af2747299acaf26bac0e22a082a16776387ba8b316043882e7ee63be5a5fa'
#      curl -s -H "X-Tenant-Token: $TOKEN" https://ridefleetmanager.com/api/public/booking/bootstrap \
#        | jq '.vehicleTypes[] | select(.passengers != null)'
#      # vehicle-classes (pon un pickupLocationId real de Rent & Go + fechas futuras):
#      curl -s -H "X-Tenant-Token: $TOKEN" "https://ridefleetmanager.com/api/public/booking/vehicle-classes?pickupLocationId=<LOC_ID>&pickupAt=2026-07-10T15:00:00Z&returnAt=2026-07-13T15:00:00Z" \
#        | jq '.classes[].vehicleType | select(.passengers != null)'
#   → Esos dos JSON son el entregable para el equipo del sitio (validan el mapeo).
#
# NOTA: para llenar los campos por UI (no SQL) hace falta un form en el admin del VehicleType —
# follow-up aparte; por ahora se llenan por el comando de arriba. El sitio enciende solo al exponerlos.
#
# DEPLOY (BACKEND only):
#   git fetch --tags && git checkout v0.9.0-beta.228
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#   # luego la migración (paso 1).
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260625_vehicle_profile_public_fields/migration.sql
#   backend/src/modules/public-booking/vehicle-feature-catalog.js
#   backend/src/modules/public-booking/public-booking.service.js
#   backend/src/modules/booking-engine/booking-engine.service.js
#   .deploy-notes/2026-06-25-ship-vehicle-profile-public-api-beta228.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.228"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260625_vehicle_profile_public_fields/migration.sql"
  "backend/src/modules/public-booking/vehicle-feature-catalog.js"
  "backend/src/modules/public-booking/public-booking.service.js"
  "backend/src/modules/booking-engine/booking-engine.service.js"
  ".deploy-notes/2026-06-25-ship-vehicle-profile-public-api-beta228.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/public-booking/vehicle-feature-catalog.js || { echo "ABORT: node --check catalog" >&2; exit 1; }
node --check backend/src/modules/public-booking/public-booking.service.js   || { echo "ABORT: node --check public-booking" >&2; exit 1; }
node --check backend/src/modules/booking-engine/booking-engine.service.js   || { echo "ABORT: node --check booking-engine" >&2; exit 1; }
grep -q "enum Transmission" backend/prisma/schema.prisma                     || { echo "ABORT: falta enum Transmission" >&2; exit 1; }
grep -q "publicVehicleProfile" backend/src/modules/public-booking/public-booking.service.js || { echo "ABORT: public-booking no usa el profile" >&2; exit 1; }
grep -q "passengers: true" backend/src/modules/booking-engine/booking-engine.service.js || { echo "ABORT: bootstrap select no trae los campos" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(public-booking): expose Vehicle Profile specs on the public API (generic)

VehicleType gains read-only public specs (passengers, bags, doors, transmission enum, features[]
from a controlled catalog, imageUrl, and an included policy: unlimitedMileage/freeMilesPerDay +
insuranceIncluded). Exposed with one shared vehicleType shape on both public endpoints the Rent & Go
site reads: GET /booking/bootstrap (vehicleTypes[]) and GET /booking/vehicle-classes(+/:id)
(class.vehicleType). booking-engine selects the fields (scoped bootstrap now includes imageUrl —
keep it a CDN URL, not base64); publicVehicleProfile() builds included:{mileage,insuranceIncluded}.
Additive migration. Backend-only. Values configurable per type (no hardcoding)."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → recreate → migración por 5432 → llenar 1 VehicleType → capturar JSON."
