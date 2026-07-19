#!/usr/bin/env bash
# Cap 6 / W1 — PATCH de reservación field-whitelisted para VozIA (cierra Cap 6 end-to-end).
#   W1_SHIP_TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-19-ship-vozia-w1-reservation-patch.sh
#
# BACKEND ONLY, CON migración ADITIVA (20260719_reservation_vozia_w1_fields:
# Reservation.flightNumber + pickupInstructions, 2 columnas nullable).
#
# QUÉ: el approve de VozIA (construido 2026-07-15, esperando este endpoint) por fin
# ejecuta contra prod. PATCH /api/reservations/:id ahora acepta service accounts con
# whitelist de EXACTAMENTE 3 campos no-dinero (flightNumber / pickupInstructions /
# contactPhone) + author + ticketId obligatorios. contactEmail EXCLUIDO (decisión de
# seguridad de Hector 2026-07-19 + Innovation MC-3: cambiar el email redirige los
# links token-gated de pago/firma — la superficie que Fase 6 cerró; cambios de email
# escalan a humano):
#   - flightNumber/pickupInstructions → columnas nuevas de Reservation (además quedan
#     LEGIBLES en GET /:id — cierra el gap #3 del audit de VozIA).
#   - contactPhone → el CUSTOMER de la reserva (contacto operativo; los agreements
#     firmados NO se mutan — documento legal). El phone auto-deriva phoneNormalized
#     vía la extensión de beta.322.
#   - AuditLog UPDATE con {source:'vozia', ticketId, author, before, after}.
#   - Cualquier otro campo → 400 (default-deny; dinero/status/fechas JAMÁS pasan).
#   - Humanos en el mismo route: INTACTOS (el branch solo corre con isServiceAccount).
#   - idempotency({kind:'vozia-patch'}) en el route (VozIA manda vozia-act-<actionId>;
#     humanos sin header pasan igual que antes).
# Allowlist: PATCH /api/reservations/:id RESERVED→ALLOWED (path abierto, campo gateado).
#
# ⚠️ BOOT-CRITICAL: vozia-reservation-patch.js es import top-level de
# reservations.routes.js → DEBE ir en FILES[] (está).
#
# MIGRACIÓN (puerto de SESIÓN 5432):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   → debe listar 20260719_reservation_vozia_w1_fields como applied.
#
# DEPLOY (BACKEND ONLY):
#   git fetch --tags && git checkout $TAG
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${W1_SHIP_TAG:?Set W1_SHIP_TAG=v0.9.0-beta.NNN (next free number) before running}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

node --check backend/src/modules/reservations/vozia-reservation-patch.js
node --check backend/src/modules/reservations/reservations.routes.js
node --check backend/src/lib/service-account-allowlist.js

FILES=(
  backend/src/modules/reservations/vozia-reservation-patch.js
  backend/src/modules/reservations/vozia-reservation-patch.test.mjs
  backend/src/modules/reservations/reservations.routes.js
  backend/src/lib/service-account-allowlist.js
  backend/src/lib/service-account-allowlist.test.mjs
  backend/prisma/schema.prisma
  backend/prisma/migrations/20260719_reservation_vozia_w1_fields/migration.sql
  backend/package.json
  .deploy-notes/2026-07-19-ship-vozia-w1-reservation-patch.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

# ⚠️ schema.prisma / package.json / reservations.routes.js son archivos compartidos.
# Correr SOLO desde un tree donde git diff de esos archivos = únicamente este workstream.
git add -- "${FILES[@]}"
git status --short --branch
git commit -m "feat(reservations): VozIA W1 field-whitelisted PATCH — Cap 6 end-to-end

Service accounts can now PATCH exactly three non-money reservation fields
(flightNumber, pickupInstructions -> new additive columns; contactPhone ->
the reservation's customer record), each write requiring author + ticketId
and leaving an AuditLog row with before/after + real actor attribution. Any
other field 400s (default-deny). contactEmail is deliberately EXCLUDED
(Hector 2026-07-19: an email change would redirect token-gated pay/sign
links — the surface Fase 6 closed; email changes escalate to a human).
Humans on the same route are untouched. Allowlist moves
PATCH /api/reservations/:id from RESERVED to ALLOWED — path open, field
gated. VozIA's approve-then-execute pipeline (built 2026-07-15) now lands
changes in prod after supervisor approval.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
