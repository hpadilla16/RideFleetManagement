#!/usr/bin/env bash
# FIX: el toggle de Market Intelligence en Access Control (tenant) no se dejaba prender.
#   bash .deploy-notes/2026-07-14-ship-tenant-modules-market-intel-select-beta307.sh
#
# BUG (reportado por Hector, International Rental Corp): con el flag del tenant
# marketIntelligenceEnabled=true, en Settings→Access Control el módulo Market
# Intelligence salía apagado y al prenderlo + Guardar volvía a apagarse.
# CAUSA: `updateTenantModuleConfig` (lib/module-access.js) cargaba el tenant con un
# select que OMITÍA `marketIntelligenceEnabled` (solo traía carSharing/loaner/tolls).
# `normalizeTenantModuleConfig` gatea `marketIntelligence = parsed && tenant
# .marketIntelligenceEnabled`; con el campo undefined → false → CADA guardado forzaba
# el módulo a OFF. (El path de LECTURA getTenantModuleConfig sí lo selecciona, por eso
# el flag del tenant se veía "enabled" en Tenants pero el toggle no pegaba.)
# Confirmado en prod: la AppSetting tenant:...:moduleAccess tenía marketIntelligence:false.
#
# FIX (1 archivo backend, 1 campo): añadir `marketIntelligenceEnabled: true` al select
# de updateTenantModuleConfig. Ahora el toggle se guarda y pega.
#
# Complementa beta.305 (que arregló el nivel per-USUARIO: marketIntelligence faltaba en
# los role maps ADMIN/OPS/AGENT). Con AMBOS: el tenant puede prender el módulo Y los
# admins lo ven por default.
#
# Tests: test:kiosk 87/87 (sin regresión). SIN migración. BACKEND-only. DEPLOY:
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend
#
# SMOKE (Hector): Settings→Access Control → marcar Market Intelligence → Guardar →
# queda marcado (ya no se revierte); los admins de International Rental Corp ven el
# módulo. NOTA: la AppSetting actual tiene marketIntelligence:false — hay que
# prenderlo una vez desde la UI (ya funcionará) o flipear el dato.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.307}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/lib/module-access.js"
  ".deploy-notes/2026-07-14-ship-tenant-modules-market-intel-select-beta307.sh"
)

# ── SANITY GATES ──
# updateTenantModuleConfig's tenant select must now include marketIntelligenceEnabled.
node -e '
const s=require("fs").readFileSync("backend/src/lib/module-access.js","utf8");
const i=s.indexOf("export async function updateTenantModuleConfig");
const j=s.indexOf("normalizeTenantModuleConfig(payload, tenant)", i);
const slice=s.slice(i, j);
if(!/marketIntelligenceEnabled:\s*true/.test(slice)){console.error("ABORT: updateTenantModuleConfig no selecciona marketIntelligenceEnabled");process.exit(1);}
' || exit 1
node --check backend/src/lib/module-access.js || { echo "ABORT: module-access no parsea" >&2; exit 1; }
echo "Guards OK (select incluye marketIntelligenceEnabled; parse OK). test:kiosk 87/87 verificado."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(access): select marketIntelligenceEnabled in updateTenantModuleConfig

The tenant-modules save loaded the tenant without marketIntelligenceEnabled,
so normalizeTenantModuleConfig (which gates marketIntelligence on that flag)
forced the module OFF on every save — the Access Control toggle never stuck
even though the tenant flag was enabled. Add the field to the select.
Complements beta.305 (per-user role map). test:kiosk 87/87. No migration.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin "$BRANCH"
git push origin "$TAG"
echo "Pushed $TAG. Deploy: build + force-recreate backend only (no migration)."
