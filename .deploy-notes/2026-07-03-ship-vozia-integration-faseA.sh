#!/usr/bin/env bash
# VozIA integración Fases 1-4: lectura (R1/R6) + cuenta de servicio + notes/idempotencia.
#   bash .deploy-notes/2026-07-03-ship-vozia-integration-faseA.sh
#   (tag default v0.9.0-beta.284 — override: TAG_OVERRIDE=v0.9.0-beta.NNN)
#
# BACKEND-only, CON migración aditiva (20260703_vozia_service_integration, auto-boot).
# Pipeline: Plan → build (Fases 1-4; pagos y PATCH-whitelist NO — diff aparte) →
# Innovation (sin MUST; hardening del gate aplicado ahora) → QA = SHIP (0 blockers).
# CERO cambio de comportamiento para usuarios humanos (JWT sin claims tv/svc = igual).
#
# QUÉ:
#   F1 — GET /api/reservations/{id} acepta también reservationNumber (RES-/TL-).
#        reservationIdWhere puro (detecta prefijo /^[A-Za-z]{2,6}-/); scope intacto.
#   F2 — GET /api/locations/{id}/hours (weeklyHours + pickupInstructions), read-only,
#        montado ANTES del router gated de /api/locations (sin requireModuleAccess:
#        la cuenta VozIA es AGENT sin settings; el resto de /api/locations cae al gated).
#   F3 — Identidad de servicio: User.isServiceAccount + tokenVersion (migración).
#        POST /api/auth/service-token (SUPER_ADMIN, expiry ≤365d default 90d) +
#        /service-token/revoke (tokenVersion++ → invalida sesión ≤30s).
#        GATE DEFAULT-DENY en requireAuth: la cuenta de servicio SOLO alcanza 10
#        endpoints allowlisted (lectura + notes); todo lo demás 403 ANTES del handler
#        (bloquea refunds/voids/deposits/PATCH/DELETE y los alias de pago). Hardening
#        (Innovation): el matcher normaliza el path y RECHAZA %2F/%2E/'..' (cierra la
#        divergencia encoded-slash antes de que Fase 6 gatee pagos).
#   F4 — Idempotency-Key (tabla IdempotencyKey): obligatorio para writes de cuenta de
#        servicio (falta → 400), replay sin re-ejecutar, hash-mismatch 422, in-flight 409,
#        TTL 24h. POST /api/reservations/{id}/notes: append-only con marcador
#        [VOZIA <ticketId> <author> @ISO] + fila AuditLog (source vozia).
#
# GAPS ACEPTADOS (QA/Innovation, para Fase 6 de pagos): idempotency IN_PROGRESS se queda
# 24h si el proceso CRASHEA antes de res.json (ok para notas; para pagos hay que rediseñar
# a marcador transaccional + idempotency del gateway, NO auto-reciclar) · ventana de
# revocación 30s (bajar TTL o point-read para pagos) · doble incremento de rate-limit en
# paths gated de /api/locations (bajo volumen). Fase 5 (PATCH whitelist) y 6 (pagos) NO
# están en este build — llegan como diffs revisables aparte.
#
# ── SMOKE (con token de la cuenta VozIA de prueba) ──
#   GET /api/reservations/RES-<num> → 200 (lookup por número).
#   GET /api/locations/<id>/hours como AGENT → 200; GET /api/locations → 403.
#   POST /api/reservations/<id>/notes sin Idempotency-Key → 400; con key → 201, repetir
#     misma key → mismo 201 con header Idempotency-Replayed: true (no duplica la nota).
#   POST /api/rental-agreements/<id>/payments/manual con token de servicio → 403 (gate).
#   Revoke → el token viejo da 401 en ≤30s.
#
# DEPLOY (BACKEND only; la migración corre sola en el boot):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# RUNBOOK cuenta VozIA (Hector, post-deploy — access control es tuyo):
#   1) Crear User (People UI): role AGENT, tenant Rent&Go, password random fuerte.
#      Módulos: solo reservations + customers (override de usuario).
#   2) Marcar como servicio (Supabase SQL editor):
#        UPDATE "User" SET "isServiceAccount"=true WHERE email='<vozia>';
#   3) Mint (como SUPER_ADMIN): POST /api/auth/service-token { userId, expiresIn:"90d" }
#      → entrega el token a VozIA por canal seguro.
#   4) Revocar: POST /api/auth/service-token/revoke { userId } (mata todos sus tokens).
#   Una cuenta por tenant.
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260703_vozia_service_integration/migration.sql
#   backend/src/modules/reservations/reservation-id.js
#   backend/src/modules/reservations/reservation-id-resolver.test.mjs
#   backend/src/modules/reservations/reservations.service.js
#   backend/src/modules/reservations/reservations.routes.js
#   backend/src/modules/reservations/vozia-note.js
#   backend/src/modules/reservations/vozia-note.test.mjs
#   backend/src/modules/locations/location-hours.routes.js
#   backend/src/modules/locations/location-hours.test.mjs
#   backend/src/modules/auth/auth.service.js
#   backend/src/modules/auth/auth.routes.js
#   backend/src/modules/auth/service-auth.test.mjs
#   backend/src/lib/service-account-allowlist.js
#   backend/src/lib/service-account-allowlist.test.mjs
#   backend/src/middleware/auth.js
#   backend/src/middleware/idempotency.js
#   backend/src/middleware/idempotency.test.mjs
#   backend/src/main.js
#   backend/package.json
#   .deploy-notes/2026-07-03-ship-vozia-integration-faseA.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.284}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260703_vozia_service_integration/migration.sql"
  "backend/src/modules/reservations/reservation-id.js"
  "backend/src/modules/reservations/reservation-id-resolver.test.mjs"
  "backend/src/modules/reservations/reservations.service.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/src/modules/reservations/vozia-note.js"
  "backend/src/modules/reservations/vozia-note.test.mjs"
  "backend/src/modules/locations/location-hours.routes.js"
  "backend/src/modules/locations/location-hours.test.mjs"
  "backend/src/modules/auth/auth.service.js"
  "backend/src/modules/auth/auth.routes.js"
  "backend/src/modules/auth/service-auth.test.mjs"
  "backend/src/lib/service-account-allowlist.js"
  "backend/src/lib/service-account-allowlist.test.mjs"
  "backend/src/middleware/auth.js"
  "backend/src/middleware/idempotency.js"
  "backend/src/middleware/idempotency.test.mjs"
  "backend/src/main.js"
  "backend/package.json"
  ".deploy-notes/2026-07-03-ship-vozia-integration-faseA.sh"
)

# ── SANITY GATES ──
for f in "${FILES[@]}"; do case "$f" in backend/src/*.js) node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; };; esac; done
grep -q "isServiceAccount" backend/prisma/schema.prisma || { echo "ABORT: schema sin isServiceAccount" >&2; exit 1; }
grep -q "IF NOT EXISTS" backend/prisma/migrations/20260703_vozia_service_integration/migration.sql || { echo "ABORT: migración no idempotente" >&2; exit 1; }
grep -q "isAllowedForServiceAccount" backend/src/middleware/auth.js || { echo "ABORT: gate no enganchado en requireAuth" >&2; exit 1; }
grep -q "%2f" backend/src/lib/service-account-allowlist.js || { echo "ABORT: allowlist sin hardening de encoded-slash" >&2; exit 1; }
( cd backend && npx prisma validate && npx prisma generate >/dev/null && npm run test:service-auth && npm run test:idempotency && npm run test:location-hours && npm run test:reservations && npm run test:auth && npm run test:scope ) || { echo "ABORT: gates fallaron" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(vozia): service-account integration Fases 1-4 (read + notes, default-deny gated)

External customer-service product (VozIA) integration, read + non-money writes.
F1: GET /api/reservations/:id also accepts the reservationNumber (RES-/TL-).
F2: GET /api/locations/:id/hours (weeklyHours + pickupInstructions), read-only,
mounted ahead of the settings-gated locations router (AGENT service account has
no settings module). F3: User.isServiceAccount + tokenVersion (additive
migration); POST /api/auth/service-token (SUPER_ADMIN mint, ≤365d) + revoke via
tokenVersion bump; a DEFAULT-DENY allowlist in requireAuth limits service
accounts to 10 read endpoints + notes and 403s everything else (refunds, voids,
deposits, PATCH/DELETE, payment aliases) before any handler — the matcher
normalizes the path and rejects %2F/dot-segment bypasses (pre-payments
hardening). F4: Idempotency-Key middleware (IdempotencyKey table, required for
service-account writes → 400 if missing, replay without re-exec, 422 on hash
mismatch, 24h TTL) + POST /api/reservations/:id/notes (append-only VOZIA marker
+ AuditLog). Human JWTs byte-compatible; zero behavior change for existing
users. Payments (Fase 6) and PATCH whitelist (Fase 5) are separate diffs. QA
SHIP; ~85 tests across the new suites."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"
echo "Pushed $TAG. Droplet: build BACKEND → recreate backend+worker (migración auto-boot). Runbook de la cuenta VozIA en el header."
