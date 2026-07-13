#!/usr/bin/env bash
# Service Schedules UI (perfil del vehículo) + tile "Maintenance Due" en el dashboard.
#   bash .deploy-notes/2026-07-13-ship-service-schedules-ui-beta295.sh
#
# GAP (Hector): el módulo maintenance (beta.206-209) computaba dues desde ServiceSchedule,
# pero NINGUNA pantalla creaba schedules (el PUT existía sin UI) y el dashboard nunca pedía
# /api/maintenance/summary → /due siempre vacío, cero notificación. Esto es la "Fase 4"
# que nunca se hizo (doc/maintenance-module-plan-2026-06-18.md).
#
# BACKEND (maintenance.service.js / maintenance.routes.js — SIN migración):
# - evalSchedule ahora es MILES-DRIVEN (decisión Hector #6): con intervalMiles + baseline +
#   odómetro, SOLO las millas deciden ok/due_soon/overdue; el next-due por días se sigue
#   devolviendo como info. Días deciden solo sin base de millas. Baseline en blanco =
#   INACTIVO (basis null, nunca due). Nuevo campo `basis` ('MILES'|'DAYS'|null).
# - NUEVO POST /api/maintenance/vehicles/:vehicleId/schedules/:serviceType/log-service —
#   "se hizo un servicio": rueda lastServiceMiles al Vehicle.mileage ACTUAL (leído en el
#   server, nunca del cliente) + lastServiceAt=now; 400 si el carro no tiene odómetro
#   (nunca fabrica baseline 0). Audit = logger.info estructurado con actor + before/after
#   (AuditLog requiere reservationId → no aplica a una acción a nivel vehículo sin migración).
# - summary devuelve dueSoonOnly (dueSoon queda = total, /maintenance lo muestra tal cual).
# - upsertSchedule/logService derivan tenantId del VEHÍCULO cuando el scope no lo trae
#   (SUPER_ADMIN llega sin ?tenantId → daba 400; cazado en browser-test). El scoping de
#   usuarios normales queda intacto (el lookup del vehículo filtra por su tenant).
# - upsert 400 sin intervalo alguno; deleteSchedule whitelistea serviceType; listSchedules
#   paralelizado + devuelve vehicleMileage.
#
# FRONTEND:
# - vehicles/[id]/page.js: sección "Service Schedules" (entre Damage y Mileage History,
#   gateada por moduleAccess.maintenance): fila por serviceType con intervalo, baseline,
#   next due (millas bold + fecha "(info)"), odómetro, remaining, pill miles-driven
#   (OK/Due soon/Overdue/"Inactive — set last service"). "+ Add schedule", Edit (con
#   Remove schedule) y "Log service" (confirm + guard de odómetro). Modal con error INLINE
#   (el banner de página queda bajo el overlay), preview en vivo del next-due, validación
#   baseline both-or-neither. Fechas date-only parseadas a mediodía (sin off-by-one FL).
# - page.js (dashboard): tile "Maintenance Due" (fetch summary module-gated soft-fail):
#   número grande = overdue, tinte rojo espejo de overdue-returns cuando >0, verde al día;
#   desc = vencidos/por-vencer/al-día (3 llaves i18n en/es). Click → /maintenance.
#   Solo counts — CERO dinero en el tile.
#
# PIPELINE: Innovation OK (1 must-change aplicado) · Graphic Design OK (1 must-change
# aplicado) · browser-test E2E en dev (tile rojo→verde, add/edit/remove/log-service) ·
# QA SHIP. Tests: maintenance.service.test.mjs 12/12 (nuevo script test:maintenance,
# --test-force-exit, sin DB — fake db inyectable); scope 28 / cache 27 / vehicles 28
# sin regresión; prisma validate OK.
#
# SIN migración. DEPLOY (BACKEND + FRONTEND):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#
# SMOKE en prod (Hector): perfil de un carro → Add schedule (ej. LOF cada 5,000 mi con
# baseline real) → pill correcto; tile "Maintenance Due" en el dashboard (rojo si hay
# vencidos, click → /maintenance); "Log service" → baseline rueda al odómetro + hoy.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.295}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/maintenance/maintenance.service.js"
  "backend/src/modules/maintenance/maintenance.routes.js"
  "backend/src/modules/maintenance/maintenance.service.test.mjs"
  "backend/package.json"
  "frontend/src/app/vehicles/[id]/page.js"
  "frontend/src/app/page.js"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  ".deploy-notes/2026-07-13-ship-service-schedules-ui-beta295.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/maintenance/maintenance.service.js || { echo "ABORT: node --check maintenance.service" >&2; exit 1; }
node --check backend/src/modules/maintenance/maintenance.routes.js || { echo "ABORT: node --check maintenance.routes" >&2; exit 1; }
grep -q "log-service" backend/src/modules/maintenance/maintenance.routes.js || { echo "ABORT: falta la ruta log-service" >&2; exit 1; }
grep -q "export function evalSchedule" backend/src/modules/maintenance/maintenance.service.js || { echo "ABORT: evalSchedule no exportado" >&2; exit 1; }
grep -q "dueSoonOnly" backend/src/modules/maintenance/maintenance.service.js || { echo "ABORT: falta dueSoonOnly en summary" >&2; exit 1; }
grep -q '"test:maintenance"' backend/package.json || { echo "ABORT: falta el script test:maintenance" >&2; exit 1; }
grep -q "tileMaintenanceDue" frontend/src/locales/en.json && grep -q "tileMaintenanceDue" frontend/src/locales/es.json || { echo "ABORT: faltan llaves i18n tileMaintenanceDue" >&2; exit 1; }
node -e "JSON.parse(require('fs').readFileSync('frontend/src/locales/en.json','utf8'));JSON.parse(require('fs').readFileSync('frontend/src/locales/es.json','utf8'));JSON.parse(require('fs').readFileSync('backend/package.json','utf8'))" || { echo "ABORT: JSON inválido" >&2; exit 1; }
( cd backend && npm run test:maintenance ) || { echo "ABORT: test:maintenance falló" >&2; exit 1; }
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK (12/12 tests, sin migración, sin money paths)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(maintenance): Service Schedules UI + Maintenance Due dashboard tile

The maintenance module computed service dues from ServiceSchedule but no screen
ever created schedules and the dashboard never fetched the summary — /due was
always empty (the plan's Fase 4 was never built). Adds the vehicle-profile
Service Schedules section (per-serviceType rows, miles-driven status pills,
Add/Edit/Remove modal with live next-due preview, inline errors) and a
module-gated Maintenance Due tile on the Ops Hub (overdue count, red tint
mirroring overdue-returns, counts only). Status is MILES-DRIVEN per Hector:
days are informational and only decide when no mileage basis exists; a blank
baseline = inactive until the last service is recorded. New
POST /api/maintenance/vehicles/:id/schedules/:type/log-service rolls the
baseline to the vehicle's server-read odometer + today (400 without an
odometer reading — never fabricates 0). upsert/log-service derive the tenant
from the vehicle row for SUPER_ADMIN scopes (was a 400 from the UI). summary
adds dueSoonOnly (dueSoon stays total). evalSchedule exported + 12 unit tests
(test:maintenance, injectable-db, no postgres needed). i18n en/es. Pipeline:
Innovation OK, Graphic Design OK, live browser E2E, QA SHIP. No migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend worker frontend -> recreate. (env-diff-check antes del deploy.)"
