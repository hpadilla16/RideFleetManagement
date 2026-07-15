#!/usr/bin/env bash
# v0.9.0-beta.313 — Kiosk: cámara arranca desde el TAP (fix iPad "allow pero no abre").
#   bash .deploy-notes/2026-07-15-ship-kiosk-camera-gesture-start-beta313.sh
#
# FRONTEND ONLY, SIN migración. QA SHIP (1 NIT no bloqueante anotado para el próximo
# toque de StaffAssistScreen: retry visible si un PhotoBox queda idle tras RequestInFlight).
#
# QUÉ (bug del re-test de Hector en beta.312, iPad Safari: dio Allow y la cámara nunca
# abrió): en iOS getUserMedia es confiable solo cuando corre DENTRO del gesto del usuario
# y sin requests concurrentes durante el diálogo de permiso. Nuevo helper compartido
# frontend/src/lib/kioskCamera.js: cero awaits antes de getUserMedia (contexto de gesto
# genuino), flag in-flight a nivel módulo (el retry/re-renders jamás doble-piden),
# isCancelled mata streams que resuelven tras unmount (cero orphans), cameraGrantedOnce
# habilita auto-start SOLO tras el primer éxito de la sesión. Las 3 superficies (ID foto,
# selfie, PhotoBox del staff) arrancan la PRIMERA vez desde el tap ("📷 Start camera").
# DIAGNÓSTICO REMOTO: todo fallo de cámara muestra el nombre real del error de iOS en
# una línea gris (NotAllowedError/NotReadableError/AbortError/videoWidth=0) + botón
# "Try again" — el próximo debug con Hector es "léeme la línea gris".
#
# ── RE-TEST de Hector (iPad Safari) ──
#   1. Hard refresh de /kiosk (o cerrar/abrir Safari).
#   2. Paso de ID: tap en "📷 Start camera" → el preview abre (o el permiso sale DESDE el
#      tap). Countdown → foto → "Leyendo tu ID…" → confirmar datos → selfie (debe
#      auto-abrir — fast path post-primer-éxito).
#   3. Si algo falla: LEER LA LÍNEA GRIS bajo el mensaje y reportarla.
#
# DEPLOY (FRONTEND ONLY):
#   git fetch --tags && git checkout v0.9.0-beta.313
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.313"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

FILES=(
  frontend/src/lib/kioskCamera.js
  frontend/src/app/kiosk/page.js
  frontend/src/components/kiosk/StaffAssistScreen.jsx
  .deploy-notes/2026-07-15-ship-kiosk-camera-gesture-start-beta313.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git commit -m "fix(kiosk): gesture-initiated camera start for iOS — shared kioskCamera helper

iPad Safari granted camera permission but the preview never opened: iOS needs
getUserMedia called synchronously inside the user gesture, exactly one request
in flight across the permission prompt, and no orphaned streams on unmount.
New shared kioskCamera.js encodes all three (no-throw contract); ID photo,
selfie, and staff PhotoBox first-start from a tap, auto-start only after the
session's first success. Camera failures now render the raw DOMException name
on screen for remote device debugging.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
