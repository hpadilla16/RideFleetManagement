#!/usr/bin/env bash
# v0.9.0-beta.314 — Kiosk: video negro en iPad — attach del stream por callback ref.
#   bash .deploy-notes/2026-07-15-ship-kiosk-video-attach-fix-beta314.sh
#
# FRONTEND ONLY, SIN migración. QA SHIP (una pasada, cero findings).
#
# QUÉ (re-test de Hector en beta.313: la cámara ENCIENDE pero el preview sale NEGRO):
# el <video> se renderiza condicional a cameraOn, y el attach por setTimeout(0) tras
# setCameraOn(true) puede correr ANTES del commit de React en WebKit lento → videoRef
# null → attach saltado en silencio → track vivo alimentando nada (caja negra visible
# gracias al minHeight/bg del 313). Fix estructural: callback ref (attachVideo) en los
# 3 <video> (ID foto, selfie, PhotoBox del staff) que conecta streamRef + play() en el
# INSTANTE en que el nodo monta (guard de idempotencia srcObject !== stream); el
# setTimeout queda como best-effort para retakes con el elemento ya montado.
#
# ── RE-TEST de Hector (iPad Safari) ──
#   1. Hard refresh de /kiosk.
#   2. Tap "📷 Start camera" → el preview debe MOSTRAR IMAGEN (espejada) — permiso ✅ +
#      encendido ✅ (313) + pintado ✅ (este fix).
#   3. Countdown → foto → OCR → confirmar → selfie (auto-abre) → resto del flujo.
#   4. Si algo falla: leer la línea gris de diagnóstico.
#
# DEPLOY (FRONTEND ONLY):
#   git fetch --tags && git checkout v0.9.0-beta.314
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.314"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

FILES=(
  frontend/src/app/kiosk/page.js
  frontend/src/components/kiosk/StaffAssistScreen.jsx
  .deploy-notes/2026-07-15-ship-kiosk-video-attach-fix-beta314.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git commit -m "fix(kiosk): attach camera stream via callback ref — iPad black preview

The conditional <video> could mount AFTER the setTimeout(0) attach on slow
WebKit (videoRef still null -> attach silently skipped -> live track feeding
a black element). attachVideo callback ref wires srcObject + play() at the
exact moment the node commits, idempotent, on all three camera surfaces.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
