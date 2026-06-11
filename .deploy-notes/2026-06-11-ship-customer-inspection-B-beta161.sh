#!/usr/bin/env bash
# v0.9.0-beta.161 — INSPECCIÓN POR EL CLIENTE, Fase B: cola de damage approval
#   bash .deploy-notes/2026-06-11-ship-customer-inspection-B-beta161.sh
#
# CODE-ONLY — NO migration (usa las tablas de beta.160). CERO money code.
# Plan: doc/customer-inspection-plan-2026-06-11.md §3.
# Cierra lo que Hector vio en el smoke de beta.160: el damage reportado no
# salía en el dashboard (la cola no existía aún) y la inspección del cliente
# no aparecía en View Inspections.
#
# QUÉ ENTRA:
#   • COLA DE REVIEW (authed /api/customer-inspections, requireAuth +
#     tenant-scoped): list (?status=SUBMITTED / ?reservationId=), detail con
#     signed URLs de las fotos, y POST /:id/reports/:reportId/review
#     {action: soft|hard}. Cuando se decide el último report → la inspección
#     pasa a REVIEWED automáticamente. Inspecciones SIN daños → REVIEWED
#     directo al submit (no ensucian la cola).
#   • DASHBOARD: KPI inspectionsToReview en /api/reports/overview + card
#     "Inspections to Review" en el Ops Hub (aparece con count > 0) →
#     /inspections/review.
#   • PÁGINA /inspections/review: lista de inspecciones SUBMITTED + el MISMO
#     diagrama que vio el cliente (vehicleDiagrams compartido) con sus dots
#     numerados por vista + card por daño (foto + descripción) con
#     Soft approve / Hard approve ("Are you sure?" antes del hard, como el
#     mockup 4 aprobado). Dots verdes = ya decididos.
#   • VIEW INSPECTIONS (reservations/:id/inspection-report): sección nueva
#     "Customer Inspection" con status (link enviado / submitted / reviewed),
#     los damage reports con foto y su estado, y link a la cola si está
#     pendiente.
#
# FILES:
#   backend/src/modules/customer-inspection/customer-inspection.service.js
#   backend/src/modules/customer-inspection/customer-inspection.routes.js
#   backend/src/modules/reports/reports.service.js
#   backend/src/main.js
#   frontend/src/app/inspections/review/page.js                 (NUEVO)
#   frontend/src/app/page.js
#   frontend/src/app/reservations/[id]/inspection-report/page.js
#   .deploy-notes/2026-06-11-ship-customer-inspection-B-beta161.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.161"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/customer-inspection/customer-inspection.service.js"
  "backend/src/modules/customer-inspection/customer-inspection.routes.js"
  "backend/src/modules/reports/reports.service.js"
  "backend/src/main.js"
  "frontend/src/app/inspections/review/page.js"
  "frontend/src/app/page.js"
  "frontend/src/app/reservations/[id]/inspection-report/page.js"
  ".deploy-notes/2026-06-11-ship-customer-inspection-B-beta161.sh"
)

# ── SYNTAX GATES.
( cd backend \
  && node --check src/modules/customer-inspection/customer-inspection.service.js \
  && node --check src/modules/customer-inspection/customer-inspection.routes.js \
  && node --check src/modules/reports/reports.service.js \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."

# ── UNIT TESTS.
( cd backend && npm run -s test:customer-inspection >/dev/null ) && echo "customer-inspection tests OK." \
  || { echo "ABORT: customer-inspection tests failed." >&2; exit 1; }

# ── FRONTEND build.
( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build failed — run 'cd frontend && npm run build' to see the error." >&2; exit 1; }

# ── GUARDS.
grep -nq "customerInspectionRouter" backend/src/main.js || { echo "ABORT: authed router not mounted." >&2; exit 1; }
grep -nq "requireAuth, tenantRateLimit, customerInspectionRouter" backend/src/main.js || { echo "ABORT: review routes unauthenticated?!" >&2; exit 1; }
grep -nq "reviewReport" backend/src/modules/customer-inspection/customer-inspection.service.js || { echo "ABORT: review logic missing." >&2; exit 1; }
grep -nq "inspectionsToReview" backend/src/modules/reports/reports.service.js || { echo "ABORT: dashboard KPI missing." >&2; exit 1; }
grep -nq "inspections-to-review" frontend/src/app/page.js || { echo "ABORT: dashboard card missing." >&2; exit 1; }
grep -nq "Are you sure" frontend/src/app/inspections/review/page.js || { echo "ABORT: hard-approve confirm missing." >&2; exit 1; }
grep -nq "Customer Inspection" "frontend/src/app/reservations/[id]/inspection-report/page.js" || { echo "ABORT: View Inspections section missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(inspection): damage approval queue + dashboard alert (phase B)

- Authed /api/customer-inspections (tenant-scoped): list submitted inspections,
  detail with signed photo URLs, and soft/hard review per damage report. Last
  decided report flips the inspection to REVIEWED; zero-damage submissions
  auto-review so the queue only holds real work.
- Dashboard: inspectionsToReview KPI + 'Inspections to Review' ops-hub card →
  /inspections/review, the agent screen from the approved mockups: same
  per-view diagram the customer annotated, numbered dots (green when decided),
  photo + description per report, soft approve or hard approve with an
  'Are you sure?' confirm (hard goes to the vehicle's permanent damage history
  — phase C renders it on the profile).
- View Inspections now shows customer-led inspections: status, damage reports
  with photos and review state, and a link to the queue while pending.

Code-only, no migration, no money code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY — no migration, frontend + backend):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + boot limpio + /health 200 + HARD refresh."
echo "  smoke (con el damage que Hector ya reportó en el smoke de beta.160):"
echo "    • Dashboard -> card 'Inspections to Review · 1' -> Review Now."
echo "    • La pantalla muestra el diagrama con el dot del cliente + su foto/nota."
echo "    • Soft approve en uno de prueba -> el card del dashboard baja/desaparece."
echo "    • Hard approve -> prompt 'Are you sure?' -> yes -> queda HARD_APPROVED"
echo "      (el Damage History del perfil lo pinta en la Fase C)."
echo "    • Reservation -> View Inspections -> sección 'Customer Inspection' con el reporte."
