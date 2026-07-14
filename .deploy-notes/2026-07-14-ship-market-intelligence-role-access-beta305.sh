#!/usr/bin/env bash
# FIX: Market Intelligence no se podía prender en Access Control (ni admin ni super).
#   bash .deploy-notes/2026-07-14-ship-market-intelligence-role-access-beta305.sh
#
# BUG (reportado por Hector, tenant International Rental Corp): MI estaba enabled a
# nivel TENANT (marketIntelligenceEnabled=true, se ve "enabled" en Tenants) pero
# NINGÚN admin lo podía ver, y en Access Control salía apagado y no dejaba prenderlo
# ni como ADMIN ni como SUPER_ADMIN. CAUSA: cuando se agregó `marketIntelligence` a
# MODULE_KEYS, se OMITIÓ de `roleAllowedModuleMap()` en los mapas de ADMIN/OPS/AGENT
# (solo SUPER_ADMIN lo tenía, porque pone todo en true). El acceso editable se
# calcula (getEditableModuleAccessForUser): sin override de usuario usa el default
# del rol → para ADMIN era false → toggle apagado y NO editable (y editar a un admin
# se gatea por el rol del usuario editado, por eso tampoco el super-admin podía).
#
# FIX (1 archivo backend): agregar `marketIntelligence: true` a los mapas de rol
# ADMIN, OPS y AGENT/staff (hosts siguen sin acceso). Decisión de roles autorizada
# por Hector (2026-07-14): ADMIN + OPS + AGENT. El flag del TENANT
# (marketIntelligenceEnabled) sigue gateando además, así que solo los tenants con MI
# encendido lo ven; y el override por-usuario sigue disponible para apagarlo puntual.
#
# Tests: test:kiosk 87/87 (incluye regresión nueva: marketIntelligence allowed para
# ADMIN/OPS/AGENT + SUPER_ADMIN, OFF para hosts). SIN migración. BACKEND-only
# (el frontend ya lista MI en sus módulos y lee el acceso efectivo del backend).
# DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend
#
# SMOKE (Hector): en International Rental Corp, con un admin → Access Control muestra
# Market Intelligence prendido/editable; el admin ya ve el módulo. (Si algún admin
# tenía un override explícito en false, ahora el toggle es editable para prenderlo.)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.305}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/lib/module-access.js"
  "backend/src/lib/module-access-kiosk.test.mjs"
  ".deploy-notes/2026-07-14-ship-market-intelligence-role-access-beta305.sh"
)

# ── SANITY GATES ──
# exactly the 3 role maps (ADMIN/OPS/AGENT) gained marketIntelligence: true.
CNT=$(grep -c "marketIntelligence: true" backend/src/lib/module-access.js || true)
[ "$CNT" = "3" ] || { echo "ABORT: se esperaban 3 'marketIntelligence: true' (ADMIN/OPS/AGENT), hay $CNT" >&2; exit 1; }
node --check backend/src/lib/module-access.js || { echo "ABORT: module-access no parsea" >&2; exit 1; }
echo "Guards OK (3 role maps + parse). test:kiosk 87/87 verificado."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(access): allow marketIntelligence for ADMIN/OPS/AGENT role maps

Market Intelligence was enabled at the tenant level but no admin could see it
and Access Control wouldn't let anyone turn it on: when marketIntelligence was
added to MODULE_KEYS it was omitted from roleAllowedModuleMap() for every role
except SUPER_ADMIN, so the editable access defaulted OFF and non-editable for
ADMIN/OPS/AGENT. Add marketIntelligence:true to those three role maps (hosts
stay off; tenant flag + per-user override still apply). Role scope authorized
by Hector 2026-07-14.

test:kiosk 87/87 (adds a regression test).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy: build + force-recreate backend only (no migration)."
