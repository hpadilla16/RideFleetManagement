#!/usr/bin/env bash
# v0.9.0-beta.229 — Public loaner self-service: /api/public/loaner (lookup/reserve/request).
#   bash .deploy-notes/2026-06-25-ship-public-loaner-selfservice-beta229.sh
#
# Backend-only, CON migración (aditiva). Para el website Rent & Go. Scoped por X-Tenant-Token, fail-closed.
# Plan: doc/public-loaner-selfservice-plan-2026-06-25.md
#
# QUÉ: router nuevo /api/public/loaner detrás de resolvePublicTenantToken + public rate-limit, con 3
# endpoints públicos para el flujo de loaner self-service del sitio. Decisiones (Hector): reserve→PENDING
# (asesor aprueba) · firma INLINE · modelo nuevo LoanerRequest · /reserve ACTUALIZA el appointment (no
# duplica) · firma → LoanerAgreement DRAFT temprano.
#
#   POST /api/public/loaner/lookup   { repairOrderNumber?, lastName?, phone? }
#     → { appointment:{id,vehicle,dateTime,location,advisor,repairOrderNumber}|null, loaners:LoanerOption[] }
#       Busca una reserva DEALERSHIP_LOANER del tenant por RO (+ lastName/phone). loaners = vehículos
#       loaner disponibles mapeados (incluye specs de beta.228: passengers/bags/transmission/imageUrl).
#   POST /api/public/loaner/reserve  { appointmentId, loanerId, signature /*dataURL PNG*/ }
#     → { confirmationNumber, reservationId }. Asigna el loaner a la reserva-appointment + marca
#       loanerSelfServiceSubmittedAt (PENDING approval) + crea/actualiza LoanerAgreement DRAFT con la firma.
#   POST /api/public/loaner/request  { name, phone, email?, repairOrderNumber?, preferredDate?, notes? }
#     → { requestId, status:"RECEIVED" }. Crea un LoanerRequest (lead) para el dashboard del asesor.
#
# CAMBIOS:
#   prisma/schema.prisma + migración 20260625_loaner_request:
#     modelo LoanerRequest (RECEIVED|CONTACTED|CONVERTED|CLOSED) + Reservation.loanerSelfServiceSubmittedAt.
#   src/modules/dealership-loaner/public-loaner.service.js  NUEVO (getLoanerOptions, lookup, createRequest, reserve)
#   src/modules/dealership-loaner/public-loaner.routes.js   NUEVO (router + requirePublicTenant fail-closed)
#   src/main.js  monta el router tras resolvePublicTenantToken
#
# Verificado local: node --check de service/routes/main ✅; prisma validate + generate ✅;
#   LOANER_PROGRAM_FILTER reusado de lib/program-category.js. main.js importa+monta el router.
#
# ── DESPUÉS DEL DEPLOY (Hector) ──
#   1. Migración por 5432 (NO 6543):
#      docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   2. Smoke con el token (TOKEN='952af2747299acaf26bac0e22a082a16776387ba8b316043882e7ee63be5a5fa'):
#      # request (siempre funciona):
#      curl -s -X POST -H "X-Tenant-Token: $TOKEN" -H "Content-Type: application/json" \
#        -d '{"name":"Juan Perez","phone":"7871234567","repairOrderNumber":"RO-TEST","notes":"prueba"}' \
#        https://ridefleetmanager.com/api/public/loaner/request | jq .
#      # lookup (loaners = vehículos loaner del tenant; appointment si hay reserva loaner con ese RO):
#      curl -s -X POST -H "X-Tenant-Token: $TOKEN" -H "Content-Type: application/json" \
#        -d '{"repairOrderNumber":"<RO real de una reserva loaner>"}' \
#        https://ridefleetmanager.com/api/public/loaner/lookup | jq .
#      # fail-closed (sin token → 401):
#      curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" -d '{}' \
#        https://ridefleetmanager.com/api/public/loaner/request
#      # reserve: necesita un appointmentId (reserva loaner) + loanerId (vehículo loaner) reales + firma dataURL.
#   → Esos 3 JSON (lookup con appointment+loaners, reserve OK, request OK) son el entregable para el sitio.
#
# NOTA: el dashboard del asesor para ver/trabajar los LoanerRequest (listado autenticado) es follow-up frontend.
#
# DEPLOY (BACKEND only):
#   git fetch --tags && git checkout v0.9.0-beta.229
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#   # luego la migración (paso 1).
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260625_loaner_request/migration.sql
#   backend/src/modules/dealership-loaner/public-loaner.service.js
#   backend/src/modules/dealership-loaner/public-loaner.routes.js
#   backend/src/main.js
#   doc/public-loaner-selfservice-plan-2026-06-25.md
#   .deploy-notes/2026-06-25-ship-public-loaner-selfservice-beta229.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.229"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260625_loaner_request/migration.sql"
  "backend/src/modules/dealership-loaner/public-loaner.service.js"
  "backend/src/modules/dealership-loaner/public-loaner.routes.js"
  "backend/src/main.js"
  "doc/public-loaner-selfservice-plan-2026-06-25.md"
  ".deploy-notes/2026-06-25-ship-public-loaner-selfservice-beta229.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/dealership-loaner/public-loaner.service.js || { echo "ABORT: node --check service" >&2; exit 1; }
node --check backend/src/modules/dealership-loaner/public-loaner.routes.js   || { echo "ABORT: node --check routes" >&2; exit 1; }
node --check backend/src/main.js                                             || { echo "ABORT: node --check main.js" >&2; exit 1; }
grep -q "publicLoanerRouter }" backend/src/main.js                           || { echo "ABORT: main.js no importa el router" >&2; exit 1; }
grep -q "app.use('/api/public/loaner', publicLoanerRouter)" backend/src/main.js || { echo "ABORT: main.js no monta el router" >&2; exit 1; }
grep -q "model LoanerRequest" backend/prisma/schema.prisma                   || { echo "ABORT: falta el modelo LoanerRequest" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(public-loaner): self-service lookup/reserve/request endpoints for the website

New /api/public/loaner router behind resolvePublicTenantToken + a public rate-limit (fail-closed,
401 without a token). lookup finds the service appointment (an existing DEALERSHIP_LOANER reservation)
by RO/lastName/phone and lists available loaner vehicles (mapped to LoanerOption with the beta.228
specs). reserve assigns the chosen loaner to the appointment reservation, flags it
loanerSelfServiceSubmittedAt (PENDING advisor approval), and creates/refreshes a LoanerAgreement DRAFT
with the inline signature. request creates a LoanerRequest lead (new model) for the advisor dashboard.
Additive migration (LoanerRequest + Reservation.loanerSelfServiceSubmittedAt). Backend-only. Plan:
doc/public-loaner-selfservice-plan-2026-06-25.md."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → recreate → migración por 5432 → smoke (request/lookup + 401 sin token)."
