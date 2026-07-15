#!/usr/bin/env bash
# v0.9.0-beta.312 — Kiosk B3c (Staff Assist con PIN) + B3d (ID por FOTO + OCR primario).
#   bash .deploy-notes/2026-07-15-ship-kiosk-staff-assist-photo-ocr-beta312.sh
#
# BACKEND + FRONTEND, CON migración ADITIVA (3 columnas nuevas en KioskSession:
# idVerifyMethod/assistUserId/assistGrantedAt — la migración 20260705_kiosk_core se
# extendió IN-PLACE otra vez, ver NOTA MIGRACIÓN abajo).
# Pipeline: Innovation ×2 + Graphic Design + QA SHIP. Acks de Hector A1/A2/A3
# (spec §Acks 2026-07-15). test:kiosk 95/95 · test:auth 10 · test:service-auth 25 ·
# test:customer-inspection 4 · frontend build limpio · import walk OK.
#
# QUÉ:
#   B3d — el paso de ID del kiosk pasa a FOTO-PRIMERO (decisión Hector tras smoke iPad:
#   pdf417 impracticable en tablet): cámara frontal → "estoy listo" → countdown 5s →
#   foto → extracción con Claude vision (patrón citation-ocr; key del tenant en Settings
#   → Agreement → "Citations OCR (AI)"; International YA la tiene puesta) → el cliente
#   CONFIRMA sus datos → verify-id existente (name-match/edad/expiry server-side, foto
#   al profile, datos a la reserva) → selfie. Extracción ADVISORY (no stampa nada) con
#   tope de costo en 3 capas fail-closed (5/sesión + 15/device/hora POR WORKER — con 4
#   workers el peor caso real es ~60/device/hora, acotado — + guard de eventsJson lleno
#   + reserva requerida). Barcode queda como path secundario.
#   B3c — Staff Assist EN el kiosk (pedido de Hector): guest trancado en ID → staff se
#   autentica con su lock-PIN existente (5 misses → lock del device 15 min, compartido
#   con el lookup; reissue de pairing code lo limpia) → grant de 10 min amarrado a la
#   sesión → entrada MANUAL del ID + foto FRENTE y ATRÁS obligatorias → mismas reglas
#   server-side (underage/expiry = hard stop igual) → idVerifiedAt method STAFF_OVERRIDE
#   + assistUserId + doble AuditLog → sesión sale de ESCALATED y el guest sigue (selfie
#   se salta en STAFF_OVERRIDE — ack A2). SIN name-match automático en el path de staff
#   (ack A1 — paridad counter, con MÁS controles). El 401 de PIN inválido ya NO
#   des-parea el device (allowlist de códigos en kioskClient — bug cazado en browser).
#   Compartido: auth.service.js ganó códigos ADITIVOS en los throws de verifyLockPin
#   (mensajes byte-idénticos, ambas suites de auth verdes).
#
# ── RE-TEST de Hector (iPad Safari, International, tablet ya pareada, key OCR ya puesta) ──
#   1. Hard refresh de /kiosk. Flujo guest: lookup → ID por FOTO (countdown → "Leyendo tu
#      ID…" → confirma tus datos) → selfie → offers → sandbox pay (si las keys están) →
#      firma → llaves. La extracción debe leer tu licencia real en ~2-5s.
#   2. Campo ilegible → "—" y "Repetir foto" como botón primario.
#   3. Staff assist: escala una sesión (Get help) → botón 🔧 discreto → escoge tu nombre →
#      tu lock-PIN (configúralo en tu perfil si no lo tienes: Settings del user → PIN) →
#      teclea el ID a mano + foto frente/atrás → "Verified by <tu nombre>" → el guest
#      sigue en offers. Prueba también un PIN malo (NO debe des-parear la tablet).
#   4. Verifica en la reserva: cliente con datos llenos + foto de licencia en el profile.
#
# DEPLOY (BACKEND + FRONTEND + MIGRACIÓN):
#   bash scripts/env-diff-check.sh   # sin keys nuevas requeridas (KIOSK_ID_OCR_MODEL es opcional y NO está en .env.example)
#   git fetch --tags && git checkout v0.9.0-beta.312
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   # ⚠️ NOTA MIGRACIÓN: 20260705_kiosk_core ya está REGISTRADA en prod (beta.287) →
#   #   migrate deploy la SALTA y las 3 columnas nuevas NO llegan solas. Pegar a mano por
#   #   el 5432 los ALTER TABLE ... ADD COLUMN IF NOT EXISTS del final del archivo
#   #   backend/prisma/migrations/20260705_kiosk_core/migration.sql (son idempotentes):
#   #   idVerifyMethod, assistUserId, assistGrantedAt (y verificar lookupMisses/
#   #   lookupLockedUntil/idVerifiedAt de betas previas si faltaran).
#   # Post-deploy: 3 contenedores healthy + boot limpio + /health interno 200 + hard refresh.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.312"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
# Guard QA-minor #1: el hunk de flexways en package.json NO debe viajar en este commit.
if git diff backend/package.json | grep -q 'flexways-worker.test.mjs'; then
  echo "ABORT: backend/package.json still carries the flexways hunk — split it first (see PM notes)" >&2; exit 1
fi
echo "Shipping $TAG from $BRANCH"

FILES=(
  # backend — nuevo
  backend/src/modules/kiosk/kiosk-staff-assist.service.js
  backend/src/modules/kiosk/kiosk-staff-assist.test.mjs
  backend/src/modules/kiosk/kiosk-id-ocr.extract.js
  # backend — modificado
  backend/src/modules/kiosk/kiosk-checkout.service.js
  backend/src/modules/kiosk/kiosk-checkout.test.mjs
  backend/src/modules/kiosk/kiosk-session.service.js
  backend/src/modules/kiosk/kiosk.routes.js
  backend/src/modules/auth/auth.service.js
  backend/prisma/schema.prisma
  backend/prisma/migrations/20260705_kiosk_core/migration.sql
  backend/package.json
  # frontend
  frontend/src/app/kiosk/page.js
  frontend/src/components/kiosk/StaffAssistScreen.jsx
  frontend/src/lib/kioskClient.js
  frontend/src/locales/en.json
  frontend/src/locales/es.json
  # docs + ship
  doc/kiosk-e2e-spec-2026-07-04.md
  doc/kiosk-mockups-2026-07-04.html
  .deploy-notes/2026-07-15-ship-kiosk-staff-assist-photo-ocr-beta312.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git commit -m "feat(kiosk): B3c staff assist (PIN + audited ID override) + B3d photo-first ID with Claude-vision OCR

B3d: primary ID path is now photo-of-license-front — 5s countdown capture,
advisory Claude-vision extraction (citation-ocr pattern, tenant key), customer
confirms their data, existing verify-id stamps/validates (name/age/expiry) and
stores the photo to the customer profile. Three-layer fail-closed cost caps.
Barcode scan demoted to secondary.

B3c: staff can rescue a stuck guest at the kiosk — existing lock-PIN auth
(brute-force shares the device lockout), 10-min session-bound grant, manual ID
entry + mandatory front/back license photos, same server-side age/expiry rules
(underage stays a hard stop), idVerifyMethod STAFF_OVERRIDE + dual audit rows,
session returns to IN_PROGRESS. Coded-401 allowlist so a PIN typo can't unpair
the device. auth.service verifyLockPin throws gain additive error codes.

Hector acks A1 (no auto name-match on staff verify), A2 (selfie skipped on
STAFF_OVERRIDE), A3 (license photo processed via Anthropic API, disclosure
updated). Pipeline: Innovation x2 + Graphic Design + QA SHIP.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG. Push with: git push origin $BRANCH --tags"
