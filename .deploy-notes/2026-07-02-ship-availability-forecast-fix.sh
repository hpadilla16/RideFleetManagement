#!/usr/bin/env bash
# Availability Forecast: atribución por carro ASIGNADO + IN_MAINTENANCE fuera de capacidad.
#   bash .deploy-notes/2026-07-02-ship-availability-forecast-fix.sh
#   (tag default v0.9.0-beta.282 — override: TAG_OVERRIDE=v0.9.0-beta.NNN)
#
# BACKEND-only, SIN migración. Pipeline: build → QA = SHIP (falsificación real: los 3
# tests nuevos FALLAN contra el código viejo y pasan con el fix; 88 tests relevantes verdes).
#
# BUG (Hector, 2026-07-02): el forecast decía 2 Jeep Wrangler FJAR disponibles cuando
# la realidad era 0 (2 CHECKED_OUT + 1 IN_MAINTENANCE). Dos causas:
#   A) reserved agrupaba por la clase RESERVADA — TL-ZE40790963BA reservó otra clase pero
#      le asignaron el Wrangler UNIT-032 → el Wrangler contaba 1 reservado en vez de 2 (y
#      la clase reservada cargaba con un carro que no está en la calle).
#   B) la capacidad incluía IN_MAINTENANCE (UNIT-025) — solo excluía OOS+SOLD.
#
# FIX (availability-forecast.report.js):
#   - Cada reserva se atribuye a la clase del CARRO ASIGNADO (fallback: clase reservada si
#     no hay carro). REEMPLAZA el bucket — imposible doble conteo. Aplica al grid, al
#     sold-out history y al drill-down de celda (misma atribución en los 3).
#   - Where ampliado: OR(vehicleTypeId≠null, vehicleId≠null) — reserva asignada con clase
#     null sigue contando como demanda.
#   - Capacidad: notIn OOS + SOLD + IN_MAINTENANCE (precedente del KPI de fleet-status).
#   - Booking pace / last-year overlay NO se reagrupan a propósito: son fleet-level y miden
#     demanda por clase reservada al momento del booking (documentado en el código).
#
# ⚠️ IMPACTO EN PRICING (aprobado por Hector): pricing-utilization (beta.204) reusa este
# computeData → el utilization % SUBE cuando hay carros en el taller o asignaciones
# cross-clase → el motor sugiere precios más altos en esas ventanas. Es lo correcto para
# revenue management, pero se nota en el dashboard de MI.
#
# GAPS ACEPTADOS (pre-existentes, QA-documentados): drill-down sin overdueIgnored y con
# overlap por instante (puede listar filas que la celda no cuenta) · CHECKED_OUT vencidos
# pasado returnAt leen como disponibles · snapshot del landing usa VehicleBlocks (no
# Vehicle.status) para maintenance — semánticas a reconciliar en un ticket aparte.
#
# ── SMOKE ──
#   Reports → Availability Forecast per Vehicle Type (International): Jeep Wrangler HOY →
#   capacity 2, reserved 2, available 0 (dispara el peak-risk callout). La clase que
#   reservó TL-ZE40790963BA ya no descuenta ese carro.
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/src/modules/reports/availability-forecast.report.js
#   backend/src/modules/reports/availability-forecast.report.test.mjs
#   backend/src/modules/market-scraper/pricing-utilization.js
#   backend/package.json
#   .deploy-notes/2026-07-02-ship-availability-forecast-fix.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.282}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reports/availability-forecast.report.js"
  "backend/src/modules/reports/availability-forecast.report.test.mjs"
  "backend/src/modules/market-scraper/pricing-utilization.js"
  "backend/package.json"
  ".deploy-notes/2026-07-02-ship-availability-forecast-fix.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/reports/availability-forecast.report.js || { echo "ABORT: node --check report" >&2; exit 1; }
node --check backend/src/modules/market-scraper/pricing-utilization.js || { echo "ABORT: node --check pricing-utilization" >&2; exit 1; }
grep -q "IN_MAINTENANCE" backend/src/modules/reports/availability-forecast.report.js || { echo "ABORT: capacidad sin exclusión de maintenance" >&2; exit 1; }
grep -q "test:reports" backend/package.json || { echo "ABORT: test:reports no está en package.json" >&2; exit 1; }
( cd backend && npm run test:reports && npm run test:market-scraper ) || { echo "ABORT: tests fallaron" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reports): availability forecast attributes reservations to the ASSIGNED vehicle's class and drops IN_MAINTENANCE from capacity

The forecast reported 2 Jeep Wranglers available with 2 CHECKED_OUT and 1 in
the shop. Reserved-per-day grouped by the BOOKED class, so a reservation
assigned a Wrangler from another booked class left the Wrangler column
undercounted (and penalized the booked class for a car that isn't out); and
capacity only excluded OUT_OF_SERVICE+SOLD, counting shop units as sellable.
Now: each reservation is attributed to the assigned vehicle's vehicleTypeId
(fallback: booked class; the bucket is REPLACED — no double counting) across
the grid, sold-out history and cell drill-down; the where clause widens to
OR(vehicleTypeId, vehicleId) so assigned-with-null-class still counts; and
capacity excludes IN_MAINTENANCE (fleet-status KPI precedent). Booking pace /
last-year overlay intentionally keep booked-class demand semantics (fleet-
level; documented). Heads-up: pricing-utilization reuses computeData, so
utilization % rises with shop units / cross-class assignments — approved.
3 new regression tests verified to FAIL on the old code; test:reports wired
into the main chain (TZ=UTC, --test-force-exit)."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"
echo "Pushed $TAG. Droplet: build BACKEND → recreate backend+worker. Smoke: forecast Wrangler → capacity 2 / reserved 2 / available 0."
