#!/usr/bin/env bash
# v0.9.0-beta.209 — Registrar un daño existente MANUALMENTE desde el perfil del vehículo (foto + dot).
#   bash .deploy-notes/2026-06-19-ship-manual-damage-profile-beta209.sh
#
# Backend + frontend, SIN migración. ZERO charge logic.
#
# QUE ENTRA:
#   - Backend: customerInspectionService.addManualDamage(vehicleId, {view,xPct,yPct,description,photoDataUrl})
#     → crea VehicleDamageReport status=HARD_APPROVED, source='MANUAL' (entra directo al Damage History
#     del perfil; foto obligatoria; reusa persistDamagePhoto). Ruta authed/tenant-scoped:
#     POST /api/customer-inspections/vehicle/:vehicleId/manual-damage (express.json 15mb por la foto).
#   - Frontend (perfil del vehículo): botón "+ Add damage" en Damage History → modal con selector de
#     vista, diagrama clickeable (tap = dot xPct/yPct), foto (cámara/upload) y descripción → guarda y
#     recarga el historial. El daño queda activo en el diagrama y se puede Fix (foto de reparación) o
#     más adelante hacerle Roll-into-RO.
#
# Verificado: node --check OK (service/routes/docs); balance de llaves/parens del perfil OK; DAMAGE_VIEWS
# + imports del diagrama presentes. El 'next build' del docker valida el JSX.
#
# Deploy: build BACKEND + FRONTEND + force-recreate. SIN migración.
#
# FILES:
#   backend/src/modules/customer-inspection/customer-inspection.service.js
#   backend/src/modules/customer-inspection/customer-inspection.routes.js
#   backend/src/docs/extra-routes.generated.js
#   frontend/src/app/vehicles/[id]/page.js
#   .deploy-notes/2026-06-19-ship-manual-damage-profile-beta209.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.209"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/customer-inspection/customer-inspection.service.js"
  "backend/src/modules/customer-inspection/customer-inspection.routes.js"
  "backend/src/docs/extra-routes.generated.js"
  "frontend/src/app/vehicles/[id]/page.js"
  ".deploy-notes/2026-06-19-ship-manual-damage-profile-beta209.sh"
)

# ── SANITY GATES ──
for f in \
  backend/src/modules/customer-inspection/customer-inspection.service.js \
  backend/src/modules/customer-inspection/customer-inspection.routes.js \
  backend/src/docs/extra-routes.generated.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
grep -q "addManualDamage" backend/src/modules/customer-inspection/customer-inspection.service.js || { echo "ABORT: falta addManualDamage." >&2; exit 1; }
grep -q "vehicle/:vehicleId/manual-damage" backend/src/modules/customer-inspection/customer-inspection.routes.js || { echo "ABORT: falta la ruta manual-damage." >&2; exit 1; }
grep -Fq "manual-damage" "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: el perfil no llama manual-damage." >&2; exit 1; }
node -e "const s=require('fs').readFileSync('frontend/src/app/vehicles/[id]/page.js','utf8'); const b=(s.match(/{/g)||[]).length-(s.match(/}/g)||[]).length,p=(s.match(/\(/g)||[]).length-(s.match(/\)/g)||[]).length; if(b||p){console.error('unbalanced',b,p);process.exit(1)}" || { echo "ABORT: perfil desbalanceado." >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(damage): manually record an existing damage from the vehicle profile

New addManualDamage(vehicleId, {view,xPct,yPct,description,photoDataUrl}) creates a
HARD_APPROVED VehicleDamageReport (source=MANUAL) so it lands straight on the profile's
Damage History — photo required, reuses persistDamagePhoto. Route POST
/api/customer-inspections/vehicle/:vehicleId/manual-damage. Profile UI: '+ Add damage'
opens a modal with a view picker, a clickable diagram (tap to drop the dot), photo
capture and a description. The damage can then be Fixed (repair photo) or, later, rolled
into a Repair Order. No migration; no charge logic."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend+frontend → force-recreate. Sin migración."
