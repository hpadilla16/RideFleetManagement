#!/usr/bin/env bash
# v0.9.0-beta.156 — FUEL TANK CAPACITY por vehículo (fixes backlog #51, P2 MONEY)
#   bash .deploy-notes/2026-06-10-ship-fuel-tank-capacity-beta156.sh
#
# ⚠️  CON MIGRACIÓN (additive) + toca fee-engine/checkin-close (MONEY-adyacente)
#     — HECTOR revisa los diffs ANTES del push:
#     git diff --staged -- backend/src/modules/fees/fee-engine.service.js
#     git diff --staged -- backend/src/modules/rental-agreements/checkin-close.service.js
#     La ARITMÉTICA del fee no cambia: misma fórmula (gap en octavos × capacity ×
#     $/gal). Cambia: (1) la capacity por fin viene del vehículo real, (2) una
#     nota en el description cuando se usa el fallback de 15 gal.
#
# BUG #51: resolveTankCapacity() seleccionaba columnas que NUNCA existieron
# (tankCapacityGallons/fuelTankSize) → Prisma tiraba, el .catch lo tragaba →
# TODO vehículo cobraba fuel como tanque de 15 gal (Suburban de 28 cobraba ~la
# mitad; compacto de 12 cobraba de más).
#
# QUÉ ENTRA (plan aprobado: doc/fuel-capacity-charge-plan-2026-06-10.md):
#   FASE A — Vehicle.fuelTankCapacityGallons DECIMAL(4,1) (migración additive
#     20260610_vehicle_fuel_tank_capacity, idempotente) + resolver lee la
#     columna real, fallback 15 SOLO si null (con logger.warn + nota visible
#     en el fee line: "assumed 15 gal tank — set vehicle fuel capacity").
#   FASE B — campo "Fuel tank capacity (gal)" en Add/Edit Vehicle + tile en el
#     Vehicle Profile ("Not set" avisa que los fees asumen 15 gal).
#   FASE C — scripts/seed-tank-capacity.mjs (NO corre en deploy): mapa
#     make/model→galones de ~60 modelos comunes; dry-run default; solo llena
#     NULL; lista los no-matcheados como TODO manual; salta EVs.
#   FASE D — checkout móvil captura fuel en OCTAVOS (9 opciones, antes cuartos);
#     fuelLevelToFraction() con los 4 enums nuevos (retrocompatible).
#   TESTS — caso canónico 22gal full→1/2 @9.99 = $109.89; capacity decimal;
#     flag del fallback; enums de octavos. + REPARADOS 2 tests stale de fuel que
#     esperaban math PRE-cuantización del 2026-06-04 (7.26→8.56, 94.5→91.91) —
#     fallaban desde aquel cambio, nadie corría test:fees completo.
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260610_vehicle_fuel_tank_capacity/migration.sql
#   backend/src/modules/fees/fee-engine.service.js
#   backend/src/modules/fees/fee-engine.test.mjs
#   backend/src/modules/rental-agreements/checkin-close.service.js
#   backend/src/modules/rental-agreements/inspection-photos-normalize.js
#   backend/src/modules/rental-agreements/inspection-photos-normalize.test.mjs
#   backend/src/modules/vehicles/vehicles.service.js
#   backend/scripts/seed-tank-capacity.mjs
#   frontend/src/app/vehicles/page.js
#   frontend/src/app/vehicles/[id]/page.js
#   frontend/src/app/checkout/mobile/[token]/page.js
#   doc/fuel-capacity-charge-plan-2026-06-10.md
#   doc/session-handoff-2026-06-10-EOD.md
#   .deploy-notes/2026-06-10-ship-fuel-tank-capacity-beta156.sh
#   (CLAUDE.md se queda fuera a propósito — nunca ha estado trackeado en el repo)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.156"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260610_vehicle_fuel_tank_capacity/migration.sql"
  "backend/src/modules/fees/fee-engine.service.js"
  "backend/src/modules/fees/fee-engine.test.mjs"
  "backend/src/modules/rental-agreements/checkin-close.service.js"
  "backend/src/modules/rental-agreements/inspection-photos-normalize.js"
  "backend/src/modules/rental-agreements/inspection-photos-normalize.test.mjs"
  "backend/src/modules/vehicles/vehicles.service.js"
  "backend/scripts/seed-tank-capacity.mjs"
  "frontend/src/app/vehicles/page.js"
  "frontend/src/app/vehicles/[id]/page.js"
  "frontend/src/app/checkout/mobile/[token]/page.js"
  "doc/fuel-capacity-charge-plan-2026-06-10.md"
  "doc/session-handoff-2026-06-10-EOD.md"
  ".deploy-notes/2026-06-10-ship-fuel-tank-capacity-beta156.sh"
)

# ── SCHEMA + SYNTAX GATES. main.js y worker.js incluidos (import path).
( cd backend && npx --no-install prisma validate >/dev/null ) && echo "prisma schema valid."
( cd backend \
  && node --check src/modules/fees/fee-engine.service.js \
  && node --check src/modules/rental-agreements/checkin-close.service.js \
  && node --check src/modules/rental-agreements/inspection-photos-normalize.js \
  && node --check src/modules/vehicles/vehicles.service.js \
  && node --check scripts/seed-tank-capacity.mjs \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."

# ── UNIT TESTS — fee engine (caso canónico $109.89 + fallback flag) e
# inspection-photos (enums de octavos).
( cd backend && node --test --test-force-exit src/modules/fees/fee-engine.test.mjs >/dev/null ) && echo "fee-engine tests OK." \
  || { echo "ABORT: fee-engine tests failed." >&2; exit 1; }
( cd backend && npm run -s test:inspection-photos >/dev/null ) && echo "inspection-photos tests OK." \
  || { echo "ABORT: inspection-photos tests failed." >&2; exit 1; }

# ── FRONTEND build.
( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build failed — run 'cd frontend && npm run build' to see the error." >&2; exit 1; }

# ── GUARDS.
grep -nq "fuelTankCapacityGallons" backend/prisma/schema.prisma || { echo "ABORT: schema column missing." >&2; exit 1; }
grep -nq 'ADD COLUMN IF NOT EXISTS "fuelTankCapacityGallons"' backend/prisma/migrations/20260610_vehicle_fuel_tank_capacity/migration.sql || { echo "ABORT: migration not idempotent/additive." >&2; exit 1; }
grep -nq "select: { fuelTankCapacityGallons: true, internalNumber: true }" backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: resolver not reading real column." >&2; exit 1; }
! grep -nq "fuelTankSize: true" backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: old fake column still selected." >&2; exit 1; }
grep -nq "assumed 15 gal tank" backend/src/modules/fees/fee-engine.service.js || { echo "ABORT: fallback note missing." >&2; exit 1; }
grep -nq "tankCapacityIsFallback" backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: fallback flag not passed." >&2; exit 1; }
grep -nq "SEVEN_EIGHTHS" backend/src/modules/rental-agreements/inspection-photos-normalize.js || { echo "ABORT: eighth enums missing in mapper." >&2; exit 1; }
grep -nq "SEVEN_EIGHTHS" "frontend/src/app/checkout/mobile/[token]/page.js" || { echo "ABORT: mobile select not in eighths." >&2; exit 1; }
grep -nq "Fuel tank capacity (gal)" frontend/src/app/vehicles/page.js || { echo "ABORT: vehicle form field missing." >&2; exit 1; }
grep -nq "fuelTankCapacityGallons: data.fuelTankCapacityGallons" backend/src/modules/vehicles/vehicles.service.js || { echo "ABORT: create whitelist missing field." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "⚠️  MONEY-ADYACENTE — REVISA LOS DIFFS AHORA:"
echo "    git diff --staged -- backend/src/modules/fees/fee-engine.service.js"
echo "    git diff --staged -- backend/src/modules/rental-agreements/checkin-close.service.js"
read -r -p "¿Diffs revisados y APROBADOS? Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(fees): per-vehicle fuel tank capacity (#51) + mobile fuel in eighths

resolveTankCapacity() selected Vehicle columns that never existed, the .catch
swallowed the Prisma error, and every vehicle billed fuel against a 15-gallon
tank. This adds the real column and wires it end to end:

- Vehicle.fuelTankCapacityGallons DECIMAL(4,1), additive idempotent migration
- resolver reads the real column; falls back to 15 only when unset, with a
  logger.warn and a visible note on the FUEL_REFILL line item
- Add/Edit Vehicle form field + Vehicle Profile tile (warns when not set)
- scripts/seed-tank-capacity.mjs: make/model→gallons seeding (dry-run default,
  never overwrites, lists unmatched vehicles as manual TODO, skips EVs)
- mobile checkout fuel select now captures EIGHTHS (gauge resolution the fee
  engine bills in); fuelLevelToFraction extended, backward compatible
- tests: canonical 22gal full→half @ \$9.99 = \$109.89, decimal capacity,
  fallback flag, eighth enums; repaired 2 stale fuel tests that predated the
  2026-06-04 eighth-quantization

Fee math unchanged: gap (eighths) × capacity × \$/gal."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (backend + frontend + MIGRACIÓN):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "MIGRACIÓN (puerto de SESIÓN 5432, nunca pgbouncer 6543):"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); npx prisma migrate deploy'"
echo
echo "POST-DEPLOY (seed de capacities, a mano):"
echo "  docker exec fleet-backend-prod node scripts/seed-tank-capacity.mjs          # dry run + lista TODO"
echo "  docker exec fleet-backend-prod node scripts/seed-tank-capacity.mjs --apply"
echo
echo "CONFIG (sin código): Settings → Fees → FUEL_REFILL = \$9.99/gal (hoy aplica el"
echo "  hardcoded \$7.00 si no hay FeeRate configurado)."
echo
echo "VERIFY: 3 containers healthy + boot limpio + /health 200 + HARD refresh."
echo "  smoke:"
echo "    • Vehicle Profile -> tile 'Fuel Tank' (Not set → editar → poner galones)."
echo "    • Check-in de prueba con carro de capacity ≠ 15 -> el fee line muestra los"
echo "      galones correctos (gap × capacity) y SIN la nota 'assumed 15 gal'."
echo "    • Check-in con carro SIN capacity -> nota 'assumed 15 gal tank' + warn en logs."
echo "    • Checkout móvil -> select de fuel con 9 opciones (octavos)."
