#!/usr/bin/env bash
# v0.9.0-beta.152 — contratos sin odometer/fuel out-in (+ mileage history que se
# saltaba) para checkouts del wizard-v2/flujo móvil.
#   bash .deploy-notes/2026-06-10-ship-contract-inspection-metrics-beta152.sh
#
# CODE-ONLY — NO migration. Backend only. Stacks on beta.151 (push-only, aún sin
# deployar — el droplet hace checkout de ESTE tag y se lleva 151+152 juntos).
#
# CAUSA RAÍZ (tercera cara del seam móvil↔desktop de beta.151): el wizard-v2 no
# llama al finalize() clásico — su cascada (checkout-session.service, toStep ===
# 'CLOSED') marcaba el agreement FINALIZED directo SIN copiar odometer/fuel desde
# la fila de inspección (donde el flujo móvil los guarda). Efectos:
#   1. El contrato imprime "-" en Odometer/Fuel Out-In (lee columnas del agreement).
#   2. El mileage history (beta.143) NUNCA registró entradas CHECKOUT para
#      checkouts v2 — recordMileageEntry solo corría en el finalize clásico.
#
# FIX:
#   - fuelLevelToFraction() (módulo normalize, unit-tested): colapsa el enum del
#     móvil (FULL/THREE_QUARTERS/...), fracciones 0..1, "3/4", percent → fracción.
#   - Contrato (agreementPrintContext): coalesce columna del agreement ??
#     fila de inspección (select SLIM — nunca photosJson). RETROACTIVO: arregla
#     los contratos ya finalizados sin tocar data.
#   - Cascada v2 (checkout-session.service): al cerrar, copia odometer/fuel de la
#     inspección CHECKOUT a las columnas (solo si están null) y registra el
#     mileage entry vía recordMileageEntrySafe (best-effort: jamás rompe el
#     finalize). ⚠ REVIEW HECTOR: el archivo es del módulo checkout-session —
#     el cambio NO toca lógica de cobro (solo métricas + mileage en el bloque
#     de status), pero por la regla de la casa, míralo con ojo.
#
# FILES:
#   backend/src/modules/rental-agreements/inspection-photos-normalize.js        (fuelLevelToFraction)
#   backend/src/modules/rental-agreements/inspection-photos-normalize.test.mjs  (8 tests, +3 de fuel)
#   backend/src/modules/rental-agreements/rental-agreements.service.js          (print context: inspections slim + coalesce)
#   backend/src/modules/checkout-session/checkout-session.service.js            (cascada: write-through métricas + mileage)
#   .deploy-notes/2026-06-10-ship-contract-inspection-metrics-beta152.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.152"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/rental-agreements/inspection-photos-normalize.js"
  "backend/src/modules/rental-agreements/inspection-photos-normalize.test.mjs"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/checkout-session/checkout-session.service.js"
  ".deploy-notes/2026-06-10-ship-contract-inspection-metrics-beta152.sh"
)

# ── SYNTAX GATE. checkout-session.service is on worker.js's import path too
#    (mobile-inspection chain) — check both entrypoints.
( cd backend \
  && node --check src/modules/rental-agreements/inspection-photos-normalize.js \
  && node --check src/modules/rental-agreements/rental-agreements.service.js \
  && node --check src/modules/checkout-session/checkout-session.service.js \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."

# ── UNIT TESTS (normalizer carries photo-shape + fuel logic; prisma-free).
( cd backend && npm run -s test:inspection-photos >/dev/null ) && echo "inspection-photos unit tests OK (8)."

# ── GUARDS.
grep -nq "fuelLevelToFraction" backend/src/modules/rental-agreements/inspection-photos-normalize.js || { echo "ABORT: fuel helper missing." >&2; exit 1; }
grep -nq "checkoutInsp?.odometer" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: contract coalesce missing." >&2; exit 1; }
grep -nq "phase: true, odometer: true, fuelLevel: true" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: slim inspections select missing." >&2; exit 1; }
! grep -nq "photosJson: true" <(grep -A3 "inspections: {" backend/src/modules/rental-agreements/rental-agreements.service.js) || { echo "ABORT: print context must NOT pull photosJson." >&2; exit 1; }
grep -nq "recordMileageEntrySafe" backend/src/modules/checkout-session/checkout-session.service.js || { echo "ABORT: cascade mileage entry missing." >&2; exit 1; }
grep -nq "fuelLevelToFraction" backend/src/modules/checkout-session/checkout-session.service.js || { echo "ABORT: cascade fuel write-through missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(contracts): surface mobile-captured odometer/fuel on agreements + restore checkout mileage entries

The wizard-v2 cascade finalize (checkout-session toStep=CLOSED) never copied
the mobile-captured odometer/fuel from the CHECKOUT inspection row onto the
agreement columns, so contracts printed '-' for Odometer/Fuel Out-In and the
beta.143 mileage-history CHECKOUT entry was silently skipped for every v2
checkout.

- fuelLevelToFraction(): mobile enum (FULL/THREE_QUARTERS/...) | 0..1 | '3/4'
  | percent -> fraction. Unit-tested.
- agreementPrintContext: coalesce agreement column ?? inspection row (slim
  select, never photosJson) -> retroactively fixes already-finalized contracts.
- v2 cascade: write odometerOut/fuelOut from the inspection row (only when the
  column is null) + recordMileageEntrySafe(CHECKOUT). Best-effort — can never
  break the finalize. No charge logic touched.

Code-only, no migration, no money code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY — trae beta.151 + beta.152 juntos):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + clean boot + /health 200 + HARD refresh."
echo "  smoke beta.152 (contratos):"
echo "    • Print/PDF de un agreement YA FINALIZADO por wizard-v2/móvil →"
echo "      Odometer Out + Fuel Out muestran valores (antes '-')."
echo "    • Un checkout v2 NUEVO end-to-end → columnas del agreement pobladas +"
echo "      entrada CHECKOUT en el mileage history del vehículo."
echo "    • Un agreement viejo (finalize clásico) → contrato igual que siempre."
echo "  smoke beta.151 (del ship anterior, mismo deploy):"
echo "    • View Inspections muestra las fotos del flujo móvil."
echo "    • View Check-in / Check-out con datos (no 'Missing')."
