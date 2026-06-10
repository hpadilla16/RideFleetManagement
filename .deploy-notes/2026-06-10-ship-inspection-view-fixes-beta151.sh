#!/usr/bin/env bash
# v0.9.0-beta.151 — fix inspection photos + ops-view (check-out/check-in) que no
# mostraban data capturada por el flujo de inspección MÓVIL.
#   bash .deploy-notes/2026-06-10-ship-inspection-view-fixes-beta151.sh
#
# CODE-ONLY — NO migration. Backend + Frontend. Stacks on beta.150
# (release/deposit-balance-fix-beta119). ZERO money code.
#
# CAUSA RAÍZ (un solo seam, dos síntomas): el flujo de inspección móvil
# (checkout/mobile, shipped ~2026-05-28) escribe en lugares/formas distintas a
# las que los "views" viejos del desktop leen:
#   BUG 1 (fotos no aparecen en View Inspections):
#     - móvil guarda photosJson como ARRAY [{key,dataUrl}]; el read path lo
#       esperaba como OBJETO {front:url}. -> p['front'] = undefined.
#     - móvil usa keys snake_case (front_seat/rear_seat/dash); el grid del
#       desktop busca camelCase (frontSeat/rearSeat/dashboard).
#   BUG 2 (View Check-in / Check-out vacíos):
#     - ops-view leía las líneas RES_CHECKOUT/RES_CHECKIN de reservation.notes
#       (las escribía el wizard VIEJO de desktop). El flujo móvil escribe a
#       RentalAgreementInspection + CheckoutSession, nunca a notes -> "Missing".
#
# FIX (sin migración, arregla TODAS las inspecciones ya guardadas):
#   - normalizeInspectionPhotos() (módulo nuevo, sin prisma): colapsa array Y
#     objeto a un mapa {slot:url}, aplicando alias de keys. El read path
#     (normalizeInspectionRow) lo usa. Backward-compatible con filas legacy.
#   - ops-view lee del endpoint estructurado /inspection-report (checkout/checkin
#     Inspection + métricas) con fallback a las líneas legacy de notes.
#
# FILES:
#   backend/src/modules/rental-agreements/inspection-photos-normalize.js        (NUEVO — normalizador, sin prisma)
#   backend/src/modules/rental-agreements/inspection-photos-normalize.test.mjs  (NUEVO — 5 tests)
#   backend/src/modules/rental-agreements/rental-agreements.service.js          (read path usa el normalizador + alias en overlay de refs)
#   backend/package.json                                                        (test:inspection-photos en la suite)
#   frontend/src/app/reservations/[id]/ops-view/page.js                         (lee inspection-report estructurado + fallback notes)
#   .deploy-notes/2026-06-10-ship-inspection-view-fixes-beta151.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.151"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/rental-agreements/inspection-photos-normalize.js"
  "backend/src/modules/rental-agreements/inspection-photos-normalize.test.mjs"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/package.json"
  "frontend/src/app/reservations/[id]/ops-view/page.js"
  ".deploy-notes/2026-06-10-ship-inspection-view-fixes-beta151.sh"
)

# ── SYNTAX GATE (backend). main.js included — the service is on its import path.
( cd backend \
  && node --check src/modules/rental-agreements/inspection-photos-normalize.js \
  && node --check src/modules/rental-agreements/rental-agreements.service.js \
  && node --check src/main.js )
echo "node --check OK."

# package.json must stay valid JSON.
( cd backend && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" ) && echo "package.json JSON OK."

# ── UNIT TESTS — the normalizer carries the bug-1 logic (no prisma, fast, no hang).
( cd backend && npm run -s test:inspection-photos >/dev/null ) && echo "inspection-photos unit tests OK."

# ── FRONTEND build (ops-view is a client page; build catches JSX/import errors).
( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build failed — run 'cd frontend && npm run build' to see the error." >&2; exit 1; }

# ── GUARDS.
grep -nq "normalizeInspectionPhotos" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: service not wired to normalizer." >&2; exit 1; }
grep -nq "front_seat" backend/src/modules/rental-agreements/inspection-photos-normalize.js || { echo "ABORT: key aliases missing." >&2; exit 1; }
grep -nq "inspection-report" "frontend/src/app/reservations/[id]/ops-view/page.js" || { echo "ABORT: ops-view not reading inspection-report." >&2; exit 1; }
grep -nq "test:inspection-photos" backend/package.json || { echo "ABORT: test not wired into suite." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(inspection): surface mobile-flow check-out/in photos + metrics in desktop views

Mobile inspection flow writes photosJson as an array with snake_case angle keys
and stores metrics in RentalAgreementInspection/CheckoutSession; the desktop
views expected a photo MAP with camelCase keys and read RES_CHECKOUT/RES_CHECKIN
from reservation.notes. Result: View Inspections showed no photos and
View Check-out/Check-in showed Missing.

- New normalizeInspectionPhotos() (prisma-free, unit-tested) collapses both
  array and map shapes to a {slot:url} map and aliases front_seat->frontSeat,
  rear_seat->rearSeat, dash->dashboard. Read path uses it -> fixes all rows
  already saved, no migration.
- ops-view reads the structured /inspection-report (checkout/checkin inspection
  + metrics) with a fallback to the legacy notes lines.

Code-only, no migration, no money code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY — no migration, frontend + backend):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + clean boot + /health 200 + HARD refresh."
echo "  smoke (un agreement con inspección capturada por el flujo MÓVIL):"
echo "    • Reservation -> View Inspections  -> las fotos del checkout/checkin aparecen"
echo "      (incl. front seat / rear seat / dashboard, antes en blanco)."
echo "    • Reservation -> View Check-in     -> Odometer/Fuel/Cleanliness con datos (no 'Missing')."
echo "    • Repite con un agreement VIEJO (desktop wizard) para confirmar que no se rompió."
