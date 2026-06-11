#!/usr/bin/env bash
# v0.9.0-beta.162 — INSPECCIÓN POR EL CLIENTE, Fase C: Damage History en el perfil
#   bash .deploy-notes/2026-06-11-ship-customer-inspection-C-beta162.sh
#
# CODE-ONLY — NO migration. CERO money code. Stacks on beta.161.
# Plan: doc/customer-inspection-plan-2026-06-11.md §4 (mockup 5 aprobado).
# Cierra lo que Hector vio en el smoke de beta.161: el hard approve quedaba
# guardado pero el perfil del vehículo no lo mostraba.
#
# QUÉ ENTRA:
#   • GET /api/customer-inspections/vehicle/:vehicleId — damage history del
#     vehículo: HARD_APPROVED (activos) + FIXED (historial). Los soft-approved
#     NUNCA aparecen (by design: no van al récord permanente).
#   • POST /api/customer-inspections/reports/:reportId/fix — marca FIXED con
#     FOTO DE LA REPARACIÓN OBLIGATORIA (Supabase, mismo shape). Solo
#     HARD_APPROVED puede fixearse; queda en el historial para siempre.
#   • VEHICLE PROFILE: sección "Damage History" — mismo diagrama por vehicle
#     type con tabs de vistas, dots ROJOS = daños activos (click → modal con
#     la foto del daño + "Was this fixed?" → foto de reparación → "Yes — mark
#     as fixed" → el dot desaparece, status FIXED) + lista colapsable "Fixed
#     history" con links a foto del daño y foto de la reparación.
#
# FILES:
#   backend/src/modules/customer-inspection/customer-inspection.service.js
#   backend/src/modules/customer-inspection/customer-inspection.routes.js
#   frontend/src/app/vehicles/[id]/page.js
#   .deploy-notes/2026-06-11-ship-customer-inspection-C-beta162.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.162"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/customer-inspection/customer-inspection.service.js"
  "backend/src/modules/customer-inspection/customer-inspection.routes.js"
  "frontend/src/app/vehicles/[id]/page.js"
  ".deploy-notes/2026-06-11-ship-customer-inspection-C-beta162.sh"
)

( cd backend \
  && node --check src/modules/customer-inspection/customer-inspection.service.js \
  && node --check src/modules/customer-inspection/customer-inspection.routes.js \
  && node --check src/main.js )
echo "node --check OK."

( cd backend && npm run -s test:customer-inspection >/dev/null ) && echo "customer-inspection tests OK." \
  || { echo "ABORT: customer-inspection tests failed." >&2; exit 1; }

( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build failed — run 'cd frontend && npm run build' to see the error." >&2; exit 1; }

grep -nq "getVehicleDamageHistory" backend/src/modules/customer-inspection/customer-inspection.service.js || { echo "ABORT: history endpoint logic missing." >&2; exit 1; }
grep -nq "fixDamageReport" backend/src/modules/customer-inspection/customer-inspection.service.js || { echo "ABORT: fix logic missing." >&2; exit 1; }
grep -nq "A photo of the repair is required" backend/src/modules/customer-inspection/customer-inspection.service.js || { echo "ABORT: repair-photo requirement missing." >&2; exit 1; }
grep -nq "vehicle/:vehicleId" backend/src/modules/customer-inspection/customer-inspection.routes.js || { echo "ABORT: history route missing." >&2; exit 1; }
grep -nq "Damage History" "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: profile section missing." >&2; exit 1; }
grep -nq "Was this fixed" "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: fix modal missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(inspection): vehicle damage history + fix workflow (phase C)

Hard-approved customer damage reports now live on the vehicle profile: a
'Damage History' section renders the same per-view diagrams with red dots for
active damages. Clicking a dot (or its row) opens the damage detail with the
customer's photo and asks 'Was this fixed?' — a repair photo is required to
mark it FIXED. Fixed damages leave the diagram but stay forever in a
collapsible history with links to both photos. Soft-approved reports never
appear here by design.

New tenant-scoped endpoints: GET /api/customer-inspections/vehicle/:vehicleId
and POST /api/customer-inspections/reports/:reportId/fix.

Code-only, no migration, no money code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY — no migration, frontend + backend):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + boot limpio + /health 200 + HARD refresh."
echo "  smoke (con el damage que Hector hard-approveó en beta.161):"
echo "    • Vehicle Profile del carro -> sección 'Damage History' -> 1 active,"
echo "      el dot rojo en la vista correcta."
echo "    • Click al dot -> foto del daño + 'Was this fixed?' -> foto de reparación"
echo "      -> 'Yes — mark as fixed' -> el dot desaparece, aparece en Fixed history."
