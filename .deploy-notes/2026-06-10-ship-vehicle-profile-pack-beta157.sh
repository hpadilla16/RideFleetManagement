#!/usr/bin/env bash
# v0.9.0-beta.157 — VEHICLE PROFILE PACK (3 features, plan aprobado por Hector)
#   bash .deploy-notes/2026-06-10-ship-vehicle-profile-pack-beta157.sh
#
# CON MIGRACIÓN (additive, 7 columnas en Vehicle). CERO money code — todo es
# informativo (el valor calculado NO factura nada).
# Plan: doc/vehicle-profile-pack-plan-2026-06-10.md (decisiones de Hector dentro).
#
# QUÉ ENTRA:
#   1. INVENTORY PHOTOS EN EL PERFIL — sección nueva con las fotos del último
#      inventario + selector de sesiones anteriores. Endpoint
#      GET /api/vehicles/:id/inventory-photos (select SLIM: solo carga el
#      photosJson de la sesión pedida; Supabase refs → signed URLs, base64
#      inline como fallback). Cero migración para esta parte.
#   2. REGISTRATION TRACKER — Vehicle.registrationExpiresAt + documento
#      (Supabase Storage, bucket inventory-photos path vehicle-docs/, columna
#      guarda "<bucket>:<path>", GET firma 1h). Tile en el perfil (verde/
#      amarillo ≤30d/rojo vencida) + campo date en Add/Edit Vehicle + upload
#      desde el perfil.
#   3. VALUE TRACKER + ROTACIÓN — acquisitionCost/acquisitionDate/
#      depreciationAnnualPct/targetFleetMonths/targetFleetMiles. Valor actual
#      CALCULADO (declining balance) en vehicle-value.js (puro, 9 unit tests).
#      Regla de rotación POR TENANT (AppSetting fleetRotationConfig,
#      TIME|MILEAGE) — GET/PUT /api/settings/fleet-rotation + selector en
#      Settings. Tile "Value" en el perfil con READY TO ROTATE.
#   4. DASHBOARD — los cards "Registrations ≤30d" y "Ready to Rotate"
#      REEMPLAZAN "Stuck Checkouts" y "Fee Advisory Watch" (decisión Hector;
#      stuck checkouts sigue accesible via /reservations?filter=stuck-checkouts
#      y los counts del backend quedan). KPIs nuevos en /api/reports/overview.
#      Deep-links: /vehicles?registration=expiring · /vehicles?rotation=ready.
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260611_vehicle_profile_pack/migration.sql
#   backend/src/modules/vehicles/vehicle-value.js                (NUEVO — puro)
#   backend/src/modules/vehicles/vehicle-value.test.mjs          (NUEVO — 9 tests)
#   backend/src/modules/vehicles/vehicles.service.js
#   backend/src/modules/vehicles/vehicles.routes.js
#   backend/src/modules/settings/settings.service.js
#   backend/src/modules/settings/settings.routes.js
#   backend/src/modules/reports/reports.service.js
#   backend/package.json                                         (vehicle-value en test:vehicles)
#   frontend/src/app/vehicles/page.js
#   frontend/src/app/vehicles/[id]/page.js
#   frontend/src/app/page.js
#   frontend/src/app/settings/page.js
#   doc/vehicle-profile-pack-plan-2026-06-10.md
#   .deploy-notes/2026-06-10-ship-vehicle-profile-pack-beta157.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.157"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260611_vehicle_profile_pack/migration.sql"
  "backend/src/modules/vehicles/vehicle-value.js"
  "backend/src/modules/vehicles/vehicle-value.test.mjs"
  "backend/src/modules/vehicles/vehicles.service.js"
  "backend/src/modules/vehicles/vehicles.routes.js"
  "backend/src/modules/settings/settings.service.js"
  "backend/src/modules/settings/settings.routes.js"
  "backend/src/modules/reports/reports.service.js"
  "backend/package.json"
  "frontend/src/app/vehicles/page.js"
  "frontend/src/app/vehicles/[id]/page.js"
  "frontend/src/app/page.js"
  "frontend/src/app/settings/page.js"
  "doc/vehicle-profile-pack-plan-2026-06-10.md"
  ".deploy-notes/2026-06-10-ship-vehicle-profile-pack-beta157.sh"
)

# ── SCHEMA + SYNTAX GATES (main.js y worker.js — import path).
( cd backend && npx --no-install prisma validate >/dev/null ) && echo "prisma schema valid."
( cd backend \
  && node --check src/modules/vehicles/vehicle-value.js \
  && node --check src/modules/vehicles/vehicles.service.js \
  && node --check src/modules/vehicles/vehicles.routes.js \
  && node --check src/modules/settings/settings.service.js \
  && node --check src/modules/settings/settings.routes.js \
  && node --check src/modules/reports/reports.service.js \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."
( cd backend && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" ) && echo "package.json JSON OK."

# ── UNIT TESTS — vehicle-value (depreciación + rotación + registración).
( cd backend && node --test --test-force-exit src/modules/vehicles/vehicle-value.test.mjs >/dev/null ) && echo "vehicle-value tests OK." \
  || { echo "ABORT: vehicle-value tests failed." >&2; exit 1; }

# ── FRONTEND build (4 páginas tocadas).
( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build failed — run 'cd frontend && npm run build' to see the error." >&2; exit 1; }

# ── GUARDS.
grep -nq 'ADD COLUMN IF NOT EXISTS "registrationExpiresAt"' backend/prisma/migrations/20260611_vehicle_profile_pack/migration.sql || { echo "ABORT: migration not idempotent." >&2; exit 1; }
grep -nq "inventory-photos" backend/src/modules/vehicles/vehicles.routes.js || { echo "ABORT: inventory-photos endpoint missing." >&2; exit 1; }
grep -nq "registration-document" backend/src/modules/vehicles/vehicles.routes.js || { echo "ABORT: registration-document endpoints missing." >&2; exit 1; }
grep -nq "getFleetRotationConfig" backend/src/modules/settings/settings.service.js || { echo "ABORT: rotation setting missing." >&2; exit 1; }
grep -nq "fleet-rotation" backend/src/modules/settings/settings.routes.js || { echo "ABORT: rotation routes missing." >&2; exit 1; }
grep -nq "registrationsExpiring30d" backend/src/modules/reports/reports.service.js || { echo "ABORT: overview KPIs missing." >&2; exit 1; }
grep -nq "Prisma.DbNull" backend/src/modules/vehicles/vehicles.service.js || { echo "ABORT: photosJson null-filter wrong." >&2; exit 1; }
grep -nq "registrations-expiring" frontend/src/app/page.js || { echo "ABORT: dashboard card missing." >&2; exit 1; }
grep -nq "ready-to-rotate" frontend/src/app/page.js || { echo "ABORT: rotate card missing." >&2; exit 1; }
! grep -nq "id: 'stuck-checkouts'" frontend/src/app/page.js || { echo "ABORT: old stuck-checkouts card still present." >&2; exit 1; }
! grep -nq "id: 'fee-advisory'" frontend/src/app/page.js || { echo "ABORT: old fee-advisory card still present." >&2; exit 1; }
grep -nq "Inventory Photos" "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: profile photos section missing." >&2; exit 1; }
grep -nq "registration=expiring" frontend/src/app/vehicles/page.js || { echo "ABORT: vehicles filters missing." >&2; exit 1; }
grep -nq "Fleet Rotation Rule" frontend/src/app/settings/page.js || { echo "ABORT: settings UI missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(vehicles): vehicle profile pack — inventory photos, registration tracker, value/rotation

- Profile: Inventory Photos section (latest session + history selector) via new
  GET /api/vehicles/:id/inventory-photos — slim select, signed Supabase URLs,
  inline-base64 fallback. Separate from rental inspections.
- Registration: Vehicle.registrationExpiresAt + document upload to Supabase
  Storage (column stores bucket:path, GET signs 1h). Profile tile with
  expired/expiring-30d states; date field on Add/Edit Vehicle.
- Value/rotation: acquisitionCost/Date, depreciationAnnualPct (declining
  balance, computed — never stored), targetFleetMonths/Miles. Per-tenant
  rotation rule (TIME|MILEAGE) in AppSetting via /api/settings/fleet-rotation
  + Settings selector. Pure vehicle-value.js helpers, 9 unit tests.
- Dashboard: 'Registrations ≤30d' and 'Ready to Rotate' cards REPLACE
  Stuck Checkouts + Fee Advisory Watch (per Hector). New overview KPIs.
  Deep-links /vehicles?registration=expiring and /vehicles?rotation=ready.

Additive migration (7 nullable Vehicle columns). Zero money code."
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
echo "VERIFY: 3 containers healthy + boot limpio + /health 200 + HARD refresh."
echo "  smoke:"
echo "    • Perfil de un vehículo que pasó por el Inventory Helper -> sección"
echo "      'Inventory Photos' con fotos y selector de sesión."
echo "    • Edit Vehicle -> fecha de registración + costo/depreciación/targets;"
echo "      el perfil muestra tiles Registration y Value."
echo "    • Subir documento de registración desde el perfil -> 'View document' abre."
echo "    • Settings -> Fleet Rotation Rule (TIME/MILEAGE) guarda."
echo "    • Dashboard: cards 'Registrations ≤30d' y 'Ready to Rotate' (aparecen"
echo "      con count > 0) -> click lleva a /vehicles filtrado."
echo
echo "POST-DEPLOY (sin código): actualizar el prompt del morning-ops-report para"
echo "  incluir registraciones por vencer + batch ready-to-rotate (Claude lo hace"
echo "  en Cowork con update_scheduled_task cuando Hector diga)."
