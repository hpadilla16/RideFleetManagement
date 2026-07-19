#!/usr/bin/env bash
# Public /api/health alias — el /health público daba 404 (pre-existente, cachado
# por el deployer en el deploy de beta.326).
#   HEALTH_SHIP_TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-19-ship-public-api-health-alias.sh
#   (siguiente número libre al preparar esto: v0.9.0-beta.327 — verificar con `git tag -l`)
#
# BACKEND ONLY, SIN migración, SIN money. UN archivo: backend/src/main.js.
#
# QUÉ: el nginx del droplet solo proxea `location /api/` al backend :4000; todo lo
# demás va al frontend Next.js → `https://ridefleetmanager.com/health` daba 404
# aunque el backend registra /health. Fix (opción b, sin tocar nginx): la ruta de
# health ahora registra AMBOS paths — app.get(['/health', '/api/health'], ...).
#   - `/health` (bare) QUEDA: lo usan el healthcheck del contenedor
#     (docker-compose.prod.yml → wget localhost:4000/health) y los curls internos.
#   - `/api/health` es el path público nuevo (pasa por nginx sin cambios).
# Docs ya actualizados (untracked, fuera de este commit): .claude/agents/deployer.md
# curlea /api/health en el verify (con fallback interno para tags viejos) y
# ops/ops-agents-config.md aclara el path público.
#
# ⚠️ BOOT-CRITICAL: cero imports nuevos — solo cambia el path de una ruta existente.
#
# ⚠️ main.js es ARCHIVO COMPARTIDO: correr SOLO desde un tree donde el diff de
# main.js sea únicamente este hunk (guard automático abajo).
#
# DEPLOY (BACKEND ONLY, sin migración):
#   git fetch --tags && git checkout $TAG
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend
#
# VERIFY post-deploy:
#   curl -sS -o /dev/null -w "%{http_code}\n" https://ridefleetmanager.com/api/health  → 200
#   ssh <droplet> 'docker exec fleet-backend-prod wget -qO- http://localhost:4000/health'  → ok:true
#   (el bare /health público sigue 404 — esperado, lo sirve el frontend; nginx NO se tocó)
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${HEALTH_SHIP_TAG:?Set HEALTH_SHIP_TAG=v0.9.0-beta.NNN (next free number) before running}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
# Nada pre-staged puede colarse al commit — index limpio o abortamos.
git diff --cached --quiet || { echo "Index is not clean — unstage everything first (git reset)" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

node --check backend/src/main.js

# Guard de archivo compartido: el diff de main.js debe ser EXACTAMENTE este hunk.
# (grep -c, no grep -q: con pipefail, grep -q SIGPIPEa en matches tempranos.)
HUNKS="$(git diff -- backend/src/main.js | grep -c '^@@' || true)"
ALIAS="$(git diff -- backend/src/main.js | grep -c "^+app.get(\['/health', '/api/health'\]" || true)"
[ "$HUNKS" = "1" ] && [ "$ALIAS" = "1" ] || {
  echo "main.js diff is not just the /api/health alias hunk (hunks=$HUNKS, alias=$ALIAS) — clean it first" >&2; exit 1; }
# Y la ruta debe quedar registrada una sola vez en el archivo resultante.
[ "$(grep -c "app.get(\['/health', '/api/health'\]" backend/src/main.js)" = "1" ] || { echo "/api/health route not registered exactly once in main.js" >&2; exit 1; }

FILES=(
  backend/src/main.js
  .deploy-notes/2026-07-19-ship-public-api-health-alias.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git status --short --branch
git commit -m "fix(health): register public /api/health alias

The droplet's nginx only proxies /api/ to the backend; everything else
goes to the Next.js frontend, so the public /health URL 404'd (caught by
the deployer during the beta.326 deploy; pre-existing). The health route
now registers both paths — bare /health stays for the container
healthcheck and internal curls; /api/health is the public path and needs
no nginx change. Deployer/ops verify docs updated separately (untracked).

Backend only, no migration, no new imports.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
