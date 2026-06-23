#!/usr/bin/env bash
# v0.9.0-beta.212 — Maintenance y Citations como módulos asignables por persona (People).
#   bash .deploy-notes/2026-06-22-ship-maintenance-citations-modules-beta212.sh
#
# Backend + Frontend, SIN migración. ZERO charge logic.
#
# QUÉ: hasta hoy Maintenance iba gateado por el módulo 'vehicles' y Citations era adminOnly
# (no asignable). Ahora ambos son MÓDULOS DE PRIMERA CLASE: aparecen como toggles en People
# (y en Settings → módulos del tenant) y se pueden asignar/quitar por persona.
#
# Decisión de Hector: ON por defecto para TODOS (admin/ops/staff) — nadie pierde acceso; él
# QUITA por persona en People. (Host = OFF, igual que el resto de módulos de staff.)
#
# CAMBIOS:
#   backend/src/lib/module-access.js
#     - MODULE_KEYS + MODULE_LABELS: + 'maintenance' + 'citations'
#     - hostRoleModuleMap: maintenance/citations = false
#     - roleAllowedModuleMap (ADMIN, OPS, staff): maintenance/citations = true
#     - defaultTenantModuleConfig: maintenance/citations = true
#       (tenants/usuarios existentes los reciben en true: normalizeTenant/UserModuleConfig
#        toman el default cuando la key no está en el JSON guardado).
#   backend/src/main.js
#     - /api/maintenance + /api/repair-orders:  requireModuleAccess('vehicles') → ('maintenance')
#     - /api/citations:                          requireRole('ADMIN','OPS') → requireModuleAccess('citations')
#   frontend/src/lib/moduleAccess.js
#     - MODULE_DEFINITIONS + pathnameToModule: + maintenance + citations
#   frontend/src/components/AppShell.jsx
#     - nav Maintenance: moduleKey 'vehicles' → 'maintenance'
#     - nav Citations:   adminOnly → moduleKey 'citations'
#   (People y Settings ya iteran MODULE_DEFINITIONS → los toggles aparecen solos.)
#   Labels i18n nav.maintenance / nav.citations ya existían (en: Maintenance/Citations · es: Mantenimiento/Multas).
#
# Verificado local: node --check (module-access.js, main.js) ✅; esbuild parse de los 3 archivos
# frontend ✅; i18n labels presentes ✅. El 'next build' del docker valida el JSX.
#
# ── CAVEAT de deploy ──
# Esta rama tiene encima beta.210 (guard de Intl, FRONTEND) y beta.211 (rate-limit, BACKEND).
# beta.212 requiere build de BACKEND **y** FRONTEND → al rebuildear el frontend se re-introduce
# el guard de Intl de 210 (inocente, ya validado). Es lo esperado.
#
# DEPLOY en el droplet (BACKEND + FRONTEND):
#   git fetch --tags && git checkout v0.9.0-beta.212
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend frontend
#   # Sin migración. Hard refresh tras el deploy.
# Verificar: People muestra toggles "Maintenance" y "Citations"; quitar uno a un usuario de
#   prueba → ese usuario deja de ver el nav y recibe 403 en /api/maintenance|citations.
#
# FILES:
#   backend/src/lib/module-access.js
#   backend/src/main.js
#   frontend/src/lib/moduleAccess.js
#   frontend/src/components/AppShell.jsx
#   .deploy-notes/2026-06-22-ship-maintenance-citations-modules-beta212.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.212"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/lib/module-access.js"
  "backend/src/main.js"
  "frontend/src/lib/moduleAccess.js"
  "frontend/src/components/AppShell.jsx"
  ".deploy-notes/2026-06-22-ship-maintenance-citations-modules-beta212.sh"
)

# ── SANITY GATES ──
node --check backend/src/lib/module-access.js || { echo "ABORT: node --check module-access" >&2; exit 1; }
node --check backend/src/main.js              || { echo "ABORT: node --check main.js" >&2; exit 1; }
for k in maintenance citations; do
  grep -q "'$k'" backend/src/lib/module-access.js || { echo "ABORT: $k falta en MODULE_KEYS" >&2; exit 1; }
  grep -q "key: '$k'" frontend/src/lib/moduleAccess.js || { echo "ABORT: $k falta en MODULE_DEFINITIONS" >&2; exit 1; }
done
grep -q "requireModuleAccess('maintenance')" backend/src/main.js || { echo "ABORT: /api/maintenance no regateado" >&2; exit 1; }
grep -q "requireModuleAccess('citations')"   backend/src/main.js || { echo "ABORT: /api/citations no regateado" >&2; exit 1; }
! grep -q "requireModuleAccess('vehicles'), repairOrdersRouter" backend/src/main.js || { echo "ABORT: repair-orders sigue en 'vehicles'" >&2; exit 1; }
grep -q "moduleKey: 'maintenance'" frontend/src/components/AppShell.jsx || { echo "ABORT: nav maintenance no actualizado" >&2; exit 1; }
grep -q "moduleKey: 'citations'"   frontend/src/components/AppShell.jsx || { echo "ABORT: nav citations no actualizado" >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(access): make Maintenance + Citations first-class assignable modules

Maintenance was gated by the 'vehicles' module and Citations was admin-only, so
neither could be assigned per-person. Both are now real module keys: they show up
as toggles in People (and the tenant module config in Settings) and gate their own
routes. Defaults ON for admin/ops/staff (host off) so nobody loses access; admins
remove per-person. Backend: MODULE_KEYS/LABELS + role/tenant defaults + main.js
regating (/api/maintenance + /api/repair-orders -> 'maintenance'; /api/citations ->
'citations'). Frontend: MODULE_DEFINITIONS + pathnameToModule + AppShell nav.
No migration; no charge logic."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND + FRONTEND → force-recreate ambos. Sin migración."
