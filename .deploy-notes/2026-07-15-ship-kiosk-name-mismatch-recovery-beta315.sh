#!/usr/bin/env bash
# v0.9.0-beta.315 — Kiosk B3e: recuperación de name-mismatch (matcher + self-service + staff).
#   bash .deploy-notes/2026-07-15-ship-kiosk-name-mismatch-recovery-beta315.sh
#
# BACKEND + FRONTEND, CON migración ADITIVA (3 columnas nuevas en KioskSession —
# nameMismatchAt/nameUpdateCodeHash/nameUpdateCodeExpiresAt; migración 20260705_kiosk_core
# extendida IN-PLACE por 5ta vez, ver NOTA MIGRACIÓN). Pipeline: Innovation ×2 + Graphic
# Design + QA SHIP. test:kiosk 116/116 · test:auth 10 · test:service-auth 25 · frontend
# build limpio · import walk OK.
#
# QUÉ (caso real de Hector: licencia FL "PADILLA LUNA HECTOR EDUARDO JR" vs reserva
# "Hector Padilla" → NAME_MISMATCH). 3 capas:
#   L1 — MATCHER por token-subset: pool de tokens de la licencia (first+last,
#     orden-agnóstico), sufijos JR/SR/II-V fuera, acentos normalizados; match cuando el
#     first-name token de la reserva + ≥1 surname + ≥2 distintos están en el pool. El caso
#     de Hector pasa SIN fricción bajo ambos splits del OCR; familiares con apellido
#     compartido NO pasan (el first-name token de la reserva es obligatorio). Toca TODO
#     verify de ID del kiosk — casos previos de aceptación siguen verdes.
#   L2 — SELF-SERVICE con código: mismatch real → código 6 díg. (sha256 at rest, TTL 10
#     min, single-use) al contacto DE LA RESERVA (destino enmascarado; preview pre-envío) →
#     código OK = prueba de posesión → nombre del driver se actualiza AL NOMBRE VERIFICADO
#     DE LA LICENCIA (jamás texto libre) con AuditLog. Customer compartido → clone-and-relink
#     (cero tokens de pago copiados, FKs intactas). Rate limit: 6 envíos/device/hora +
#     cooldown 60s server-side (anti email/SMS cannon). Reglas edad/expiry NUNCA se relajan.
#   L3 — STAFF bypass ligero del name-match: PIN existente (grant B3c) → avala la licencia
#     SIN re-teclear ni re-fotos → STAFF_NAME_OVERRIDE + AuditLog, sin mutar el nombre.
#
# ── RE-TEST de Hector (iPad, International, key OCR ya puesta) ──
#   1. Hard refresh /kiosk. Con TU licencia real: el matcher L1 debe pasar tu nombre SIN
#      que aparezca ninguna pantalla de mismatch (ese era el bug — ahora silencioso).
#   2. Para probar L2 a propósito: una reserva con un nombre que NO matchee tu licencia →
#      "Verify it's my reservation" → código al email/teléfono de la reserva → entra →
#      "Reservation updated" → selfie. (Espera del código: el idle aguanta 4 min en esa
#      pantalla.) Cooldown de reenvío 60s vs lockout por hora se distinguen en el UI.
#   3. L3: mismatch → 🔧 → tu PIN → tarjeta de attest ("I verified this license…") → sigue.
#
# DEPLOY (BACKEND + FRONTEND + MIGRACIÓN):
#   bash scripts/env-diff-check.sh   # sin keys nuevas requeridas
#   git fetch --tags && git checkout v0.9.0-beta.315
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   # ⚠️ NOTA MIGRACIÓN (5ta edición in-place): 20260705_kiosk_core YA está registrada en
#   #   prod → migrate deploy la SALTA y las 3 columnas nuevas NO llegan solas. Pegar a
#   #   mano por el 5432 los ALTER guardeados (líneas 75-77 del migration.sql), idempotentes:
#   #     ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "nameMismatchAt" TIMESTAMP(3);
#   #     ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "nameUpdateCodeHash" TEXT;
#   #     ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "nameUpdateCodeExpiresAt" TIMESTAMP(3);
#   #   Verificar en information_schema.columns tras pegarlos.
#   # Post-deploy: 3 contenedores healthy + boot limpio + /health interno 200 + hard refresh.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.315"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
# Guard: el hunk de flexways en package.json NO debe viajar (si sigue en el working tree).
if git diff backend/package.json | grep -q 'flexways-worker.test.mjs'; then
  echo "ABORT: split the flexways hunk in backend/package.json first" >&2; exit 1
fi
echo "Shipping $TAG from $BRANCH"

FILES=(
  backend/src/modules/kiosk/kiosk-name-update.service.js
  backend/src/modules/kiosk/kiosk-name-update.test.mjs
  backend/src/modules/kiosk/kiosk-checkout.service.js
  backend/src/modules/kiosk/kiosk-checkout.test.mjs
  backend/src/modules/kiosk/kiosk-session.service.js
  backend/src/modules/kiosk/kiosk-staff-assist.service.js
  backend/src/modules/kiosk/kiosk-staff-assist.test.mjs
  backend/src/modules/kiosk/kiosk.routes.js
  backend/prisma/schema.prisma
  backend/prisma/migrations/20260705_kiosk_core/migration.sql
  frontend/src/components/kiosk/NameUpdateFlow.jsx
  frontend/src/app/kiosk/page.js
  frontend/src/app/kiosk/layout.js
  frontend/src/components/kiosk/KioskUiContext.js
  frontend/src/components/kiosk/StaffAssistScreen.jsx
  frontend/src/lib/kioskClient.js
  frontend/src/locales/en.json
  frontend/src/locales/es.json
  doc/kiosk-e2e-spec-2026-07-04.md
  .deploy-notes/2026-07-15-ship-kiosk-name-mismatch-recovery-beta315.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git commit -m "feat(kiosk): B3e name-mismatch recovery — token matcher + self-service code + staff attest

L1: token-subset name matcher (pooled license tokens, suffix-strip, first+last
anchored) — passes 'PADILLA LUNA HECTOR EDUARDO JR' vs 'Hector Padilla' silently
while blocking family-surname-sharing wrong-person accepts.
L2: self-service — a 6-digit code (hashed, 10-min TTL, single-use, 6/device/hr +
60s cooldown) to the reservation's contact proves possession, then the driver
name updates to the LICENSE-verified name (clone-and-relink for shared customers,
zero payment state copied), audited. Age/expiry never relaxed.
L3: staff attest — existing lock-PIN grant approves the name mismatch without
re-entry or re-photos (STAFF_NAME_OVERRIDE, audited, no mutation).

Pipeline: Innovation x2 + Graphic Design + QA SHIP.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG. Push with: git push origin $BRANCH --tags"
