#!/usr/bin/env bash
# v0.9.0-beta.198 — Customer-led inspection FASE D (check-in / return side).
#   bash .deploy-notes/2026-06-18-ship-customer-inspection-fase-d-beta198.sh
#
# Backend + frontend, code-only, SIN migración (el campo InspectionPhase.CHECKIN ya existía).
# ZERO money code — el cierre del check-in NO se tocó; solo se gatea el PASO de inspección.
#
# QUE ENTRA:
#   1) Email de check-in: customerInspectionService.sendCheckinInspection() crea una inspección
#      phase=CHECKIN + token 24h (atado directo a la reserva, sin checkout-session) y emaila al
#      cliente. Ruta manual: POST /api/customer-inspections/checkin/:reservationId (?force=1).
#   2) Scheduler D-1: checkin-reminders.scheduler.js (worker poll) — el día antes del return (FL)
#      barre las reservas CHECKED_OUT y manda el email (dedupe en DB). Registrado en worker.js.
#      Flags opcionales (defaults seguros): CHECKIN_INSPECTION_REMINDERS_{ENABLED,INTERVAL_HOURS,
#      STARTUP_SECONDS}. NO van en .env.example (no se fuerzan).
#   3) QR por-vehículo: QR estático firmado (HMAC sobre JWT_SECRET, sin columna nueva) que al
#      escanear resuelve la renta activa del carro → token → /inspect. Rutas: pública
#      GET /api/customer-inspection/v/:payload, authed GET /api/customer-inspections/vehicle/:id/
#      checkin-qr. Frontend: /inspect/v/[payload] (resolver) + botón "Print Check-in QR" en el perfil.
#   4) Check-in sin agente (detrás de SETTING): settings customerInspectionConfig gana checkinModel
#      'AGENT' (actual, default) | 'CUSTOMER'. Con CUSTOMER + inspección del cliente presente, el
#      paso de fotos del check-in wizard es OPCIONAL (banner + skip; el agente igual puede añadir).
#      Toggle en Settings → Customer-led Inspection.
#
# Deploy: build BACKEND + FRONTEND + force-recreate. SIN migración, SIN env nuevas obligatorias.
#
# FILES:
#   backend/src/modules/customer-inspection/customer-inspection.service.js
#   backend/src/modules/customer-inspection/customer-inspection.routes.js
#   backend/src/modules/customer-inspection/checkin-reminders.scheduler.js   (NUEVO)
#   backend/src/worker.js
#   backend/src/modules/settings/settings.service.js
#   frontend/src/app/settings/page.js
#   frontend/src/app/vehicles/[id]/page.js
#   frontend/src/app/reservations/[id]/checkin-wizard/page.js
#   frontend/src/app/inspect/v/[payload]/page.js   (NUEVO)
#   .deploy-notes/2026-06-18-ship-customer-inspection-fase-d-beta198.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.198"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/customer-inspection/customer-inspection.service.js"
  "backend/src/modules/customer-inspection/customer-inspection.routes.js"
  "backend/src/modules/customer-inspection/checkin-reminders.scheduler.js"
  "backend/src/worker.js"
  "backend/src/modules/settings/settings.service.js"
  "frontend/src/app/settings/page.js"
  "frontend/src/app/vehicles/[id]/page.js"
  "frontend/src/app/reservations/[id]/checkin-wizard/page.js"
  "frontend/src/app/inspect/v/[payload]/page.js"
  ".deploy-notes/2026-06-18-ship-customer-inspection-fase-d-beta198.sh"
)

# ── BOOT-SAFETY GATES ──
# New backend module must exist + be in FILES[] (worker.js imports it, guarded, but ship it anyway).
[ -f backend/src/modules/customer-inspection/checkin-reminders.scheduler.js ] || { echo "ABORT: falta checkin-reminders.scheduler.js" >&2; exit 1; }
[ -f "frontend/src/app/inspect/v/[payload]/page.js" ] || { echo "ABORT: falta el resolver /inspect/v/[payload]" >&2; exit 1; }
for must in \
  "backend/src/modules/customer-inspection/checkin-reminders.scheduler.js" \
  "frontend/src/app/inspect/v/[payload]/page.js"; do
  printf '%s\n' "${FILES[@]}" | grep -Fqx "$must" || { echo "ABORT: $must no está en FILES[]." >&2; exit 1; }
done
# Parse-check every backend file.
for f in \
  backend/src/modules/customer-inspection/customer-inspection.service.js \
  backend/src/modules/customer-inspection/customer-inspection.routes.js \
  backend/src/modules/customer-inspection/checkin-reminders.scheduler.js \
  backend/src/worker.js \
  backend/src/modules/settings/settings.service.js; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
# Wiring sanity.
grep -q "startCheckinReminders" backend/src/worker.js || { echo "ABORT: worker no arranca el scheduler de check-in." >&2; exit 1; }
grep -q "sendCheckinInspection" backend/src/modules/customer-inspection/customer-inspection.service.js || { echo "ABORT: falta sendCheckinInspection." >&2; exit 1; }
grep -q "checkinModel" backend/src/modules/settings/settings.service.js || { echo "ABORT: settings sin checkinModel." >&2; exit 1; }
echo "Guards OK. (Frontend lo valida el 'next build' en el docker build del deploy.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(inspection): customer-led inspection Fase D (check-in / return)

D-1 check-in email (sendCheckinInspection: phase=CHECKIN, 24h token bound to the reservation) +
worker scheduler that sends it the day before return (DB-deduped). Printed per-vehicle QR
(HMAC-signed, no schema column) that resolves the active rental to a check-in inspection token,
with a /inspect/v/[payload] resolver and a 'Print Check-in QR' button on the vehicle profile.
New tenant setting checkinModel AGENT|CUSTOMER: with CUSTOMER + an existing customer inspection,
the check-in wizard's photo step is optional (banner + skip; agent can still add). No migration
(InspectionPhase.CHECKIN already existed). Zero money code — the check-in close is untouched."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. En el droplet: build backend+frontend → force-recreate. Sin migración."
