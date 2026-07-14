#!/usr/bin/env bash
# HOTFIX: el panel de Flexways no dejaba AGREGAR sede — "idSede is required".
#   bash .deploy-notes/2026-07-13-ship-flexways-sede-idsede-field-hotfix-beta301.sh
#
# BUG (prod, al configurar la primera sede tras encender Flexways beta.300):
# Settings→Integrations→Flexways→Add sede tiraba 400 "idSede is required" y no
# dejaba agregar el mapeo idSede→location. CAUSA: mismatch de nombre de campo —
# el panel POSTeaba `{ externalSede: sede, ... }` pero el backend
# (flexways.routes.js:336) lee `req.body.idSede` y responde 400 si falta. El
# contrato entero del panel decía `externalSede` (comentarios 46-49 + el body del
# POST) pero el modelo/rutas del backend siempre usaron `idSede`. El GET/display
# no se afectaba (sedeOf lee `externalSede ?? idSede` → cae bien a idSede); solo
# el ADD estaba roto. Nunca se cachó porque los tests del panel no ejercen el
# POST real y el primer add de sede ocurrió recién al ir a encender en vivo.
#
# FIX (1 archivo, frontend): el POST manda `{ idSede: sede, ... }` (nombre que el
# backend ya exige) + comentarios del contrato corregidos a idSede.
#
# VERIFICADO (round-trip contra el backend local): POST con `externalSede` → 400
# "idSede is required" (repro exacta); POST con `idSede` → 200 sede creada. Fila
# de prueba limpiada.
#
# SIN migración. FRONTEND ONLY. DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
#   # HARD REFRESH del browser tras el deploy (chunks nuevos).
#
# SMOKE: Settings → Integrations → Flexways → Add sede (idSede=383, location Zezgo
# Orlando, enabled) → se agrega sin error; aparece en la grilla de sedes.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.301}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/components/settings/FlexwaysIntegrationPanel.jsx"
  ".deploy-notes/2026-07-13-ship-flexways-sede-idsede-field-hotfix-beta301.sh"
)

# ── SANITY GATES ──
# The POST body must send idSede (not the old externalSede).
grep -q "JSON.stringify({ idSede: sede" frontend/src/components/settings/FlexwaysIntegrationPanel.jsx || { echo "ABORT: el POST no manda idSede" >&2; exit 1; }
grep -q "externalSede: sede" frontend/src/components/settings/FlexwaysIntegrationPanel.jsx && { echo "ABORT: todavía queda externalSede en el POST" >&2; exit 1; } || true
node -e "const {transformSync}=require('$REPO_ROOT/frontend/node_modules/next/dist/build/swc'); transformSync(require('fs').readFileSync('frontend/src/components/settings/FlexwaysIntegrationPanel.jsx','utf8'),{jsc:{parser:{syntax:'ecmascript',jsx:true}},filename:'x.jsx'})" || { echo "ABORT: el panel no parsea" >&2; exit 1; }
echo "Guards OK (POST manda idSede; sin externalSede residual; parse OK; round-trip local verificado)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(flexways): panel POSTs idSede (not externalSede) when adding a sede

Adding a sede in Settings->Integrations->Flexways failed with 400
\"idSede is required\": the panel POSTed { externalSede } but the backend
(flexways.routes.js) reads req.body.idSede. Field-name contract mismatch —
the whole panel contract said externalSede while the model/routes always
used idSede. Only the ADD path broke (GET/display already falls back to
idSede). Fix: POST { idSede } + corrected the contract comments.

Verified via a local round-trip: externalSede -> 400 (repro), idSede -> 200.
Frontend-only, no migration.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy: build + force-recreate frontend only (no migration). Hard-refresh after."
