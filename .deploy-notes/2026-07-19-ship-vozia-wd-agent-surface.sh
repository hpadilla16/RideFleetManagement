#!/usr/bin/env bash
# S27 W-D — superficie RFM para el Agent Live Workspace de VozIA (agentes humanos).
#   WD_SHIP_TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-19-ship-vozia-wd-agent-surface.sh
#
# BACKEND ONLY, SIN migración (cero cambios de schema — todo monta sobre columnas
# y servicios existentes).
#
# QUÉ (política Hector 2026-07-19: agentes operan DIRECTO; approval solo para info
# sensitiva del cliente y refunds — esos gates viven del lado de VozIA):
#   1. CANCEL vía PATCH /api/reservations/:id (service account): validador propio
#      (vozia-reservation-ops.js) — status CANCELLED + cancellationReason + author +
#      ticketId obligatorios, SOLO pre-pickup (NEW/CONFIRMED, 409 NOT_PRE_PICKUP).
#      Reusa reservationsService.update → vehicle-status-sync libera el carro igual
#      que un cancel de staff. AuditLog STATUS_CHANGE source:vozia.
#   2. GET /api/reservations/:id/reprice-preview — diff de precio para cambio de
#      fechas/location propuesto. READ-ONLY (quotesService.preview, cero filas).
#      Motor real (tax-aware + revenue pricing), nunca math de UI.
#   3. POST /api/reservations/:id/reschedule — aplica el cambio con reprice:
#      expectedNewTotal como staleness guard (409 REPRICE_DRIFT si el precio se
#      movió desde el preview), pre-pickup only, gates reales de update() (hours/
#      conflict/AGREEMENT_IMMUTABLE), estampa dailyRate+estimatedTotal del engine,
#      audit before/after. idempotency kind:vozia-reschedule.
#   4. POST /api/reservations/:id/extend (existente) abierto al service account:
#      author+ticketId obligatorios (van al note → charge row/addendum trail) +
#      idempotency kind:vozia-extend (extend crea charges — replay = double-extend).
#   5. GET+PUT /api/reservations/:id/additional-drivers (existentes) allowlisted.
#   6. GET /api/reservations/:id/available-services — catálogo activo del pickup
#      location de la reserva (additionalServicesService.list), read-only.
#   7. POST /api/reservations/:id/send-detail-email: service accounts SOLO al email
#      en archivo (extraEmails stripped — la superficie que Fase 6 cerró) + author/
#      ticketId + AuditLog.
#   8. PATCH /api/customers/:id (service account): field-whitelist email/address1/
#      address2/city/state/zip (vozia-customer-patch.js), exactamente UN campo +
#      author+ticketId. EMAIL = blindaje de Hector: aviso automático al email VIEJO
#      (best-effort, "si no fuiste tú llama") + oldEmailNotified en el audit.
#      idempotency kind:vozia-customer. Humanos en el route: INTACTOS.
#      OJO: en VozIA esta es la ÚNICA categoría con aprobación de supervisor; Chloe
#      (IA) sigue sin poder tocar email (su executor no lo lista).
#
# MONEY: CERO rutas de gateway tocadas. Las 3 de dinero (send-request-email/refund/
# charges) ya estaban allowlisted desde Fase 6 con sus guards — no se tocan aquí.
# Reprice/extend son MONEY-ADJACENT (estimatedTotal/charge rows) vía servicios
# existentes ya en prod.
#
# ⚠️ BOOT-CRITICAL: vozia-reservation-ops.js y ../quotes/quotes.service.js son
# imports top-level de reservations.routes.js; vozia-customer-patch.js de
# customers.routes.js → DEBEN estar trackeados o en FILES[] (están: los nuevos van
# en FILES[], quotes.service.js ya está trackeado desde beta.323).
#
# DEPLOY (BACKEND ONLY, sin migración):
#   git fetch --tags && git checkout $TAG
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${WD_SHIP_TAG:?Set WD_SHIP_TAG=v0.9.0-beta.NNN (next free number) before running}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
# QA minor-4: nada pre-staged puede colarse al commit — index limpio o abortamos.
git diff --cached --quiet || { echo "Index is not clean — unstage everything first (git reset)" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

node --check backend/src/modules/reservations/vozia-reservation-ops.js
node --check backend/src/modules/reservations/reservations.routes.js
node --check backend/src/modules/reservations/reservation-extend.routes.js
node --check backend/src/modules/customers/vozia-customer-patch.js
node --check backend/src/modules/customers/customers.routes.js
node --check backend/src/lib/service-account-allowlist.js
node --check backend/src/middleware/idempotency.js

# Suites del workstream (force-exit) — verde o no hay tag. OJO Mac: los tests
# DB-backed necesitan el postgres LOCAL 5432/fleet_management (backend/.env
# apunta al 5433 muerto) — exportamos el default si no viene uno.
export DATABASE_URL="${DATABASE_URL:-postgresql://$(whoami)@localhost:5432/fleet_management}"
( cd backend \
  && npm run test:service-auth \
  && npm run test:vozia-customer \
  && npm run test:reservations \
  && npm run test:quotes )

FILES=(
  backend/src/modules/reservations/vozia-reservation-ops.js
  backend/src/modules/reservations/vozia-reservation-ops.test.mjs
  backend/src/modules/reservations/reservations.routes.js
  backend/src/modules/reservations/reservation-extend.routes.js
  backend/src/modules/customers/vozia-customer-patch.js
  backend/src/modules/customers/vozia-customer-patch.test.mjs
  backend/src/modules/customers/customers.routes.js
  backend/src/lib/service-account-allowlist.js
  backend/src/lib/service-account-allowlist.test.mjs
  backend/src/middleware/idempotency.js
  backend/package.json
  .deploy-notes/2026-07-19-ship-vozia-wd-agent-surface.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

# ⚠️ package.json / reservations.routes.js / customers.routes.js son archivos
# compartidos. Correr SOLO desde un tree donde git diff de esos archivos =
# únicamente este workstream (verificado 2026-07-19: diff de package.json trae
# solo los 3 hunks de tests de W-D (ops en test:reservations, test:vozia-customer nuevo + cadena, force-exit en customers-scope); schema.prisma NO va en FILES[] — el diff
# que tiene es del workstream kiosk, NO tocarlo).
git add -- "${FILES[@]}"
git status --short --branch
git commit -m "feat(reservations,customers): S27 W-D — VozIA agent-workspace surface

Human agents operate RFM from the VozIA workspace through the service
account (Hector 2026-07-19: agents act DIRECT; approval only for sensitive
customer info + refunds, enforced on the VozIA side). New surface, each
write payload-gated + attributed (author/ticketId) + audited:

- Cancel via PATCH (service account): reason mandatory, pre-pickup only
  (NEW/CONFIRMED -> 409 NOT_PRE_PICKUP), reuses reservationsService.update
  so vehicle-status-sync releases the car like a staff cancel.
- GET /:id/reprice-preview: read-only live-engine price diff for a proposed
  date/location change (quotesService.preview — zero rows written).
- POST /:id/reschedule: applies the change WITH repricing; expectedNewTotal
  staleness guard (409 REPRICE_DRIFT), real update() gates, stamps
  dailyRate/estimatedTotal from the engine, idempotent.
- POST /:id/extend opened to service accounts: attribution folded into the
  note + idempotency (extend creates charge rows; replay = double-extend).
- GET/PUT /:id/additional-drivers + GET /:id/available-services allowlisted.
- send-detail-email: service accounts send ONLY to the on-file email
  (extraEmails stripped) + attribution + audit.
- PATCH /api/customers/:id (service account): one-field whitelist
  email/address1/address2/city/state/zip; email changes notify the OLD
  address (Hector's blindaje) with oldEmailNotified recorded in the audit.
  Humans on both routes untouched.

No schema changes. No gateway code touched — the three Fase 6 money routes
were already allowlisted with their guards and are not modified.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
