#!/usr/bin/env bash
# v0.9.0-beta.158 — REPORTE "Fleet Value & Rotation" + 2 ajustes UX del perfil
#   bash .deploy-notes/2026-06-10-ship-fleet-value-report-profile-ux-beta158.sh
#
# CODE-ONLY — NO migration. CERO money code. Stacks on beta.157.
#
# QUÉ ENTRA:
#   1. REPORTE NUEVO "Fleet Value & Rotation" (Reports → Fleet) — pedido de
#      Hector: valor de inventario + lista por carro con costo de entrada,
#      depreciación, valor actual y cuándo le toca venta. Usa los MISMOS
#      helpers de vehicle-value.js que el tile del dashboard (nunca
#      desacuerdan) y la regla de rotación del tenant (TIME|MILEAGE).
#      KPIs: Invested · Value today · Depreciated · Ready to sell. PDF +
#      Excel gratis via el registry de reports-v2. Ordena ready →
#      approaching → in window. Lista cuántos vehículos faltan por trackear.
#      NOTA: 'upcoming-vehicle-sales' (COMING_SOON desde 05-27 por falta de
#      inputs) queda anotado — los inputs ya existen (beta.157) y este
#      reporte los usa; decidir luego si se retira o se fusiona.
#   2. PERFIL: el upload del documento de registración ahora es BOTÓN real
#      (violeta, estilo global) en vez de label plano (pedido de Hector
#      sobre screenshot del deploy de beta.157).
#   3. PERFIL: botón "Edit vehicle" en el header de Vehicle Details →
#      /vehicles?edit=<id> abre el modal de edición directo (deep-link
#      nuevo en la página de vehicles), sin tener que buscar el carro.
#   4. HOTFIX (descubierto por Hector en prod beta.157): PATCH
#      /api/vehicles/:id devolvía 500 al editar — el form manda
#      registrationExpiresAt/acquisitionDate como "YYYY-MM-DD" y el update()
#      pasaba el patch crudo a Prisma (que exige Date/ISO completo). El
#      update ahora normaliza esas dos fechas (create() ya lo hacía).
#
# FILES:
#   backend/src/modules/reports/fleet-value.report.js        (NUEVO)
#   backend/src/modules/reports/register-all-reports.js
#   backend/src/modules/reports/reports-v2.service.js        (catálogo)
#   frontend/src/app/reports-v2/fleet-value/page.js          (NUEVO)
#   frontend/src/app/vehicles/[id]/page.js                   (botón upload + Edit vehicle)
#   frontend/src/app/vehicles/page.js                        (?edit= deep-link)
#   .deploy-notes/2026-06-10-ship-fleet-value-report-profile-ux-beta158.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.158"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reports/fleet-value.report.js"
  "backend/src/modules/reports/register-all-reports.js"
  "backend/src/modules/reports/reports-v2.service.js"
  "backend/src/modules/vehicles/vehicles.service.js"
  "frontend/src/app/reports-v2/fleet-value/page.js"
  "frontend/src/app/vehicles/[id]/page.js"
  "frontend/src/app/vehicles/page.js"
  ".deploy-notes/2026-06-10-ship-fleet-value-report-profile-ux-beta158.sh"
)

# ── SYNTAX GATE. main.js incluido — register-all-reports está en su import path.
( cd backend \
  && node --check src/modules/reports/fleet-value.report.js \
  && node --check src/modules/reports/register-all-reports.js \
  && node --check src/modules/reports/reports-v2.service.js \
  && node --check src/modules/vehicles/vehicles.service.js \
  && node --check src/main.js )
echo "node --check OK."

# ── UNIT TESTS — vehicle-value (el reporte depende de sus helpers).
( cd backend && node --test --test-force-exit src/modules/vehicles/vehicle-value.test.mjs >/dev/null ) && echo "vehicle-value tests OK." \
  || { echo "ABORT: vehicle-value tests failed." >&2; exit 1; }

# ── FRONTEND build.
( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build failed — run 'cd frontend && npm run build' to see the error." >&2; exit 1; }

# ── GUARDS.
grep -nq "import './fleet-value.report.js'" backend/src/modules/reports/register-all-reports.js || { echo "ABORT: report not registered." >&2; exit 1; }
grep -nq "slug: 'fleet-value'" backend/src/modules/reports/reports-v2.service.js || { echo "ABORT: catalog entry missing." >&2; exit 1; }
grep -nq "registerReport({" backend/src/modules/reports/fleet-value.report.js || { echo "ABORT: registerReport missing." >&2; exit 1; }
grep -nq "computeVehicleValue" backend/src/modules/reports/fleet-value.report.js || { echo "ABORT: report not using shared value helpers." >&2; exit 1; }
grep -nq "fleet-value" frontend/src/app/reports-v2/fleet-value/page.js || { echo "ABORT: report page missing." >&2; exit 1; }
grep -nq "regFileInputRef" "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: upload button fix missing." >&2; exit 1; }
grep -nq "Edit vehicle" "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: Edit vehicle button missing." >&2; exit 1; }
grep -nq "searchParams?.get('edit')" frontend/src/app/vehicles/page.js || { echo "ABORT: ?edit deep-link missing." >&2; exit 1; }
# HOTFIX beta.158: PATCH /vehicles/:id 500 — fechas date-only del form vs Prisma.
grep -nq "for (const key of \['registrationExpiresAt', 'acquisitionDate'\])" backend/src/modules/vehicles/vehicles.service.js || { echo "ABORT: PATCH date-normalize hotfix missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(reports): Fleet Value & Rotation report + vehicle profile UX

- New reports-v2 report 'fleet-value' (Reports → Fleet): total invested vs
  current declining-balance value, per-vehicle list with acquisition cost,
  depreciation %/amount, value today and sale-due (tenant rule TIME|MILEAGE).
  Reuses vehicle-value.js so it always agrees with the dashboard tile. PDF +
  Excel via the registry. Surfaces how many vehicles lack value data.
- Profile: registration-document upload is now a real button (global violet
  style) instead of a plain label; added 'Edit vehicle' button that deep-links
  to /vehicles?edit=<id> which auto-opens the edit modal.

Code-only, no migration, no money code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY — no migration, frontend + backend):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + boot limpio + /health 200 + HARD refresh."
echo "  smoke:"
echo "    • Reports → Fleet → 'Fleet Value & Rotation' -> KPIs + tabla; PDF y Excel bajan."
echo "    • Llenar cost/%/fecha en un par de carros -> aparecen con valor calculado."
echo "    • Perfil -> botón violeta 'Upload document' abre el file picker y sube."
echo "    • Perfil -> 'Edit vehicle' abre el modal de edición directo."
