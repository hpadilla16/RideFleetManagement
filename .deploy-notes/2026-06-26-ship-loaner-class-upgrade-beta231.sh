#!/usr/bin/env bash
# v0.9.0-beta.231 — Loaner self-service: per-class upgrade pricing + checked-out lock.
#   bash .deploy-notes/2026-06-26-ship-loaner-class-upgrade-beta231.sh
#
# Backend + RFM admin tab, CON migración (aditiva). Para el website Rent & Go (LoanerFlow.tsx).
# Plan: doc/loaner-selfservice-class-upgrade-plan-2026-06-25.md
#
# QUÉ:
#  1) Rate.purpose (RENTAL|LOANER) — un price book de loaner por tenant (Rate purpose=LOANER + RateItems).
#     ratesService.resolveForRental / list / findRatesByLocationCode EXCLUYEN purpose=LOANER → AISLAMIENTO:
#     las tarifas de loaner NUNCA aparecen en una cotización de renta.
#  2) Reservation.serviceVehicleTypeId — clase del vehículo en servicio = ANCLA de elegibilidad del loaner.
#     intake() la captura. Null/legacy → elegibilidad = clase del loaner asignado (delta $0).
#  3) /api/public/loaner/lookup — ahora devuelve status, serviceVehicle{label,classLabel}, entitledClassLabel,
#     assignedLoaner, agreement{available,url}, y por loaner dailyRate + upgradeDeltaPerDay.
#  4) /api/public/loaner/reserve — GUARD (bug fix): status ∉ {NEW,CONFIRMED} → 409. Diferencial de upgrade:
#     si la clase elegida > la elegible, marca CUSTOMER_PAY + PENDING_APPROVAL + estimatedTotal (sin gateway).
#  5) Admin: pestaña Settings "Loaner Rates" (GET/PUT /api/settings/loaner-rates).
#
# Decisiones (Hector): D1 reuse Rate/RateItem con tag · D2 FK serviceVehicleTypeId · D3 estimate + nota visible ·
#   D4 pestaña en Settings. Default: clase sin tarifa = $0 (cubierto); link de acuerdo = /customer/loaner-portal.
#
# VERIFICADO LOCAL (sandbox, Postgres 16 real):
#   prisma validate ✅ · migración aplica desde estado pre-cambio + idempotente ✅
#   Phase1 integración 6/6 (rate book + AISLAMIENTO loaner↔renta) ✅
#   Phase2+3 integración 14/14 (lookup enriquecido, diferencial, guard 409, $0 cubierto) ✅
#   Unit puro loaner-pricing 6/6 ✅ · test:loaner 16/16 ✅ · test:rates 3/3 ✅
#   NOTA: test:public-booking tiene 1 fallo PRE-EXISTENTE en beta.230 (getWebsiteMandatoryFees), no introducido aquí.
#   PENDIENTE de verificar por Hector: `next build` del frontend (pestaña Loaner Rates — additiva).
#
# ── DESPUÉS DEL DEPLOY (Hector) ──
#   1. Migración por 5432 (NO 6543):
#      docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   2. Set de tarifas (admin → Settings → Loaner Rates) o por API (PUT /api/settings/loaner-rates).
#   3. Smoke con X-Tenant-Token (ver doc/loaner-class-upgrade-runbook-2026-06-26.md):
#      - lookup de un RO NEW/CONFIRMED → serviceVehicle+entitledClassLabel+loaners con upgradeDeltaPerDay+agreement+status
#      - reserve clase > elegible → diferencial pendiente (sin cobro online); misma/menor → $0
#      - reserve sobre RO CHECKED_OUT → 409
#   → Esos JSON son el entregable para el sitio.
#
# DEPLOY:
#   git fetch --tags && git checkout v0.9.0-beta.231
#   docker compose -f docker-compose.prod.yml build backend && docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#   # frontend (Vercel/host) build incluye la pestaña Loaner Rates. Luego la migración (paso 1).
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260625_rate_purpose_and_service_type/migration.sql
#   backend/src/modules/rates/rates.service.js
#   backend/src/modules/reservations/reservations.service.js
#   backend/src/modules/dealership-loaner/dealership-loaner.service.js
#   backend/src/modules/dealership-loaner/public-loaner.service.js
#   backend/src/modules/dealership-loaner/loaner-pricing.js
#   backend/src/modules/dealership-loaner/loaner-pricing.test.mjs
#   backend/src/modules/dealership-loaner/loaner-rate.service.js
#   backend/src/modules/dealership-loaner/loaner-rate.routes.js
#   backend/src/main.js
#   backend/package.json
#   frontend/src/app/settings/page.js
#   frontend/src/app/settings/LoanerRatesTab.js
#   doc/loaner-selfservice-class-upgrade-plan-2026-06-25.md
#   .deploy-notes/2026-06-26-ship-loaner-class-upgrade-beta231.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.231"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

# ── SANITY GATES ──
for f in rates/rates.service reservations/reservations.service dealership-loaner/dealership-loaner.service \
         dealership-loaner/public-loaner.service dealership-loaner/loaner-pricing dealership-loaner/loaner-rate.service \
         dealership-loaner/loaner-rate.routes main; do
  node --check "backend/src/modules/$f.js" 2>/dev/null || node --check "backend/src/$f.js" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
grep -q "enum RatePurpose" backend/prisma/schema.prisma || { echo "ABORT: falta RatePurpose" >&2; exit 1; }
grep -q "serviceVehicleTypeId" backend/prisma/schema.prisma || { echo "ABORT: falta serviceVehicleTypeId" >&2; exit 1; }
grep -q "purpose: { not: 'LOANER' }" backend/src/modules/rates/rates.service.js || { echo "ABORT: falta aislamiento en resolveForRental" >&2; exit 1; }
grep -q "loanerRateRouter" backend/src/main.js || { echo "ABORT: ruta loaner-rates no montada" >&2; exit 1; }
echo "Guards OK. Run: (cd backend && npm run test:loaner && npm run test:rates) and frontend 'next build' before tagging."
echo "Then: git add -- <FILES>; git commit; git tag $TAG; git push origin $BRANCH --tags"
