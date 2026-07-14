#!/usr/bin/env bash
# v0.9.0-beta.302 — Kiosk: fixes de cámara para iPad/WebKit (smoke real de Hector en beta.287+).
#   bash .deploy-notes/2026-07-13-ship-kiosk-ipad-camera-fixes-beta302.sh
#
# FRONTEND ONLY, SIN migración. QA del delta: SHIP requerido antes de correr esto.
#
# QUÉ (3 bugs del smoke en iPad Safari):
#   1. El license scanner usaba cámara TRASERA en el kiosk (herencia del flujo loaner).
#      Nuevo prop facingMode en LicenseScanner (default 'environment' → loaner intacto);
#      el kiosk pasa 'user' (frontal) con preview espejado SOLO por CSS — el decode y la
#      foto de evidencia leen frames crudos sin espejo.
#   2. El selfie no montaba cámara: WebKit permite UN stream a la vez y el del scanner no
#      se soltaba completo. Teardown duro (stop tracks + srcObject null + video.pause) +
#      gracia de 350ms antes del selfie + retry único a los 500ms + botón "Upload photo"
#      SIEMPRE visible en el paso de selfie.
#   3. Scan >5 min en iPad (no hay BarcodeDetector nativo en WebKit → zxing): frontal a
#      1280×720, pacing del decoder (350ms, requestVideoFrameCallback), y a los 12s sin
#      decode un hint traducido que resalta el upload del barcode (siempre visible).
#
# ── RE-TEST de Hector en el iPad (Safari) tras el deploy ──
#   1. Hard refresh de /kiosk en la tablet (o re-abrir Safari).
#   2. ID scan: debe abrir la cámara FRONTAL con preview espejado; licencia decodifica
#      levantándola de frente. Si tarda, a los ~12s sale el banner de "sube una foto".
#   3. Selfie: la cámara debe montar; si no, el botón de upload está a la vista.
#   4. Spot-check del flujo de loaner (scanner ahí sigue con cámara trasera, igual que antes).
#
# DEPLOY (FRONTEND ONLY):
#   git fetch --tags && git checkout v0.9.0-beta.302
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
#   # Sin migración. Hard refresh en la tablet tras el deploy.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.302"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

FILES=(
  frontend/src/components/loaner/LicenseScanner.jsx
  frontend/src/app/kiosk/page.js
  frontend/src/locales/en.json
  frontend/src/locales/es.json
  .deploy-notes/2026-07-13-ship-kiosk-ipad-camera-fixes-beta302.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git commit -m "fix(kiosk): iPad/WebKit camera fixes — front-facing scanner, selfie stream teardown, slow-scan upload path

facingMode prop on LicenseScanner (kiosk=user w/ CSS-mirrored preview, decode
from raw frames; loaner default unchanged), hard stream teardown + grace +
retry so the selfie camera mounts on WebKit's single-stream rule, 1280x720
front constraints + zxing pacing + 12s translated upload hint, always-visible
upload fallbacks on ID and selfie steps. Found in Hector's real-iPad smoke.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG. Push with: git push origin $BRANCH --tags"
