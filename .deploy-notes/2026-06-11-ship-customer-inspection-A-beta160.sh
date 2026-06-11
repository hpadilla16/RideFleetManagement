#!/usr/bin/env bash
# v0.9.0-beta.160 — INSPECCIÓN POR EL CLIENTE, Fase A (plan aprobado + mockups v4)
#   bash .deploy-notes/2026-06-11-ship-customer-inspection-A-beta160.sh
#
# CON MIGRACIÓN (additive). Plan: doc/customer-inspection-plan-2026-06-11.md
# ⚠️ Toca checkout-session.service/routes (NO money: kinds de token + TTL +
#    endpoint nuevo). HECTOR revisa esos diffs antes del push:
#    git diff --staged -- backend/src/modules/checkout-session/checkout-session.service.js
#    git diff --staged -- backend/src/modules/checkout-session/checkout-session.routes.js
#
# QUÉ ENTRA (Fase A de 4):
#   • MIGRACIÓN: HandoffTokenKind.CUSTOMER_INSPECTION + enums VehicleView/
#     CustomerInspectionStatus/DamageReportStatus + tablas CustomerInspection
#     y VehicleDamageReport (idempotente, additive).
#   • SETTING por tenant (Settings → "Customer-led Inspection", default OFF).
#   • STEP 4 del checkout wizard con DOS salidas (solo si el setting está ON):
#     "Send inspection link to customer" → email con link 24h + disclosures,
#     y el wizard camina por la state machine NORMAL hasta CLOSED (cascade de
#     finalize + email del agreement intactos; eventos marcan delegatedToCustomer).
#     "Do inspection for customer" → QR fail-safe, flujo actual intacto.
#     Setting OFF → step 4 idéntico a hoy.
#   • PÁGINA PÚBLICA /inspect/:token (token = auth, igual que /checkout/mobile):
#     paso 1 confirma identidad+carro+disclosures; paso 2 diagramas por VEHICLE
#     TYPE (suv/sedan/van/pickup, line-art violeta aprobado) con 5 vistas
#     (Left/Right/Front/Rear/Interior) — tap → dot → foto OBLIGATORIA + nota →
#     POST por daño; Finish → SUBMITTED (0+ daños válido). Fotos a Supabase
#     (bucket inventory-photos, path customer-damage/) con fallback inline.
#   • Los reports quedan REPORTED esperando la cola de approval (Fase B).
#
# FILES:
#   backend/prisma/schema.prisma
#   backend/prisma/migrations/20260611_customer_inspection/migration.sql
#   backend/src/modules/customer-inspection/customer-inspection.service.js   (NUEVO)
#   backend/src/modules/customer-inspection/customer-inspection.routes.js    (NUEVO)
#   backend/src/modules/customer-inspection/customer-inspection.test.mjs     (NUEVO)
#   backend/src/modules/checkout-session/checkout-session.service.js
#   backend/src/modules/checkout-session/checkout-session.routes.js
#   backend/src/modules/settings/settings.service.js
#   backend/src/modules/settings/settings.routes.js
#   backend/src/main.js
#   backend/package.json
#   frontend/src/components/vehicleDiagrams.js                               (NUEVO)
#   frontend/src/app/inspect/[token]/page.js                                 (NUEVO)
#   frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js
#   frontend/src/app/settings/page.js
#   doc/customer-inspection-plan-2026-06-11.md
#   .deploy-notes/2026-06-11-ship-customer-inspection-A-beta160.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.160"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260611_customer_inspection/migration.sql"
  "backend/src/modules/customer-inspection/customer-inspection.service.js"
  "backend/src/modules/customer-inspection/customer-inspection.routes.js"
  "backend/src/modules/customer-inspection/customer-inspection.test.mjs"
  "backend/src/modules/checkout-session/checkout-session.service.js"
  "backend/src/modules/checkout-session/checkout-session.routes.js"
  "backend/src/modules/settings/settings.service.js"
  "backend/src/modules/settings/settings.routes.js"
  "backend/src/main.js"
  "backend/package.json"
  "frontend/src/components/vehicleDiagrams.js"
  "frontend/src/app/inspect/[token]/page.js"
  "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js"
  "frontend/src/app/settings/page.js"
  "doc/customer-inspection-plan-2026-06-11.md"
  ".deploy-notes/2026-06-11-ship-customer-inspection-A-beta160.sh"
)

# ── SCHEMA + SYNTAX GATES (main.js y worker.js — import path).
( cd backend && npx --no-install prisma validate >/dev/null ) && echo "prisma schema valid."
( cd backend \
  && node --check src/modules/customer-inspection/customer-inspection.service.js \
  && node --check src/modules/customer-inspection/customer-inspection.routes.js \
  && node --check src/modules/checkout-session/checkout-session.service.js \
  && node --check src/modules/checkout-session/checkout-session.routes.js \
  && node --check src/modules/settings/settings.service.js \
  && node --check src/modules/settings/settings.routes.js \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."
( cd backend && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" ) && echo "package.json JSON OK."

# ── UNIT TESTS.
( cd backend && npm run -s test:customer-inspection >/dev/null ) && echo "customer-inspection tests OK." \
  || { echo "ABORT: customer-inspection tests failed." >&2; exit 1; }

# ── FRONTEND build.
( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build failed — run 'cd frontend && npm run build' to see the error." >&2; exit 1; }

# ── GUARDS.
grep -nq "ADD VALUE IF NOT EXISTS 'CUSTOMER_INSPECTION'" backend/prisma/migrations/20260611_customer_inspection/migration.sql || { echo "ABORT: token kind migration missing." >&2; exit 1; }
grep -nq 'CREATE TABLE IF NOT EXISTS "VehicleDamageReport"' backend/prisma/migrations/20260611_customer_inspection/migration.sql || { echo "ABORT: damage table migration missing." >&2; exit 1; }
grep -nq "'CUSTOMER_INSPECTION'" backend/src/modules/checkout-session/checkout-session.service.js || { echo "ABORT: mint kind missing." >&2; exit 1; }
grep -nq "send-customer-inspection" backend/src/modules/checkout-session/checkout-session.routes.js || { echo "ABORT: send endpoint missing." >&2; exit 1; }
grep -nq "customer-inspection" backend/src/main.js || { echo "ABORT: public router not mounted." >&2; exit 1; }
grep -nq "getCustomerInspectionConfig" backend/src/modules/settings/settings.service.js || { echo "ABORT: setting missing." >&2; exit 1; }
grep -nq "Send inspection link to customer" "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js" || { echo "ABORT: step 4 two-button UI missing." >&2; exit 1; }
grep -nq "diagramFor" "frontend/src/app/inspect/[token]/page.js" || { echo "ABORT: customer page missing diagrams." >&2; exit 1; }
grep -nq "Customer-led Inspection" frontend/src/app/settings/page.js || { echo "ABORT: settings toggle missing." >&2; exit 1; }
# El flujo viejo debe seguir intacto cuando el setting está OFF:
grep -nq "Do inspection for customer" "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js" || { echo "ABORT: QR fail-safe option missing." >&2; exit 1; }
grep -nq "checkout/mobile/" "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js" || { echo "ABORT: QR flow removed?!" >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "⚠️  REVISA LOS DIFFS de checkout-session (kinds/TTL/endpoint, cero money):"
echo "    git diff --staged -- backend/src/modules/checkout-session/checkout-session.service.js"
echo "    git diff --staged -- backend/src/modules/checkout-session/checkout-session.routes.js"
read -r -p "¿Diffs revisados? Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(inspection): customer-led checkout inspection (phase A)

Tenant setting (default OFF) adds a second exit to checkout step 4: email the
customer a 24h inspection link (+ responsibility disclosures) and finish the
checkout through the normal state machine to CLOSED — finalize cascade and
agreement email untouched, events flagged delegatedToCustomer. The agent QR
walkthrough stays as the fail-safe and is byte-identical when the setting is
off.

Customer flow (/inspect/:token, token-is-auth like /checkout/mobile): confirm
identity + vehicle, then annotate damages as dots on per-vehicle-type line-art
diagrams (suv/sedan/van/pickup × left/right/front/rear/interior). Each dot
requires a photo (Supabase Storage, inline fallback) + short description.
Reports land as VehicleDamageReport REPORTED for the phase-B approval queue
(soft/hard) and the phase-C vehicle damage history.

Additive migration: CUSTOMER_INSPECTION token kind, VehicleView /
CustomerInspectionStatus / DamageReportStatus enums, CustomerInspection +
VehicleDamageReport tables. Zero money code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (backend + frontend + MIGRACIÓN):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "MIGRACIÓN (puerto de SESIÓN 5432, nunca pgbouncer 6543):"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); npx prisma migrate deploy'"
echo
echo "CONFIG: Settings → Customer-led Inspection → ON (para el tenant que lo use)."
echo
echo "VERIFY: 3 containers healthy + boot limpio + /health 200 + HARD refresh."
echo "  smoke (con el setting ON, en una reserva de PRUEBA):"
echo "    • Checkout hasta step 4 -> aparecen los DOS botones."
echo "    • 'Send link & finish checkout' -> email llega, wizard termina en Closed,"
echo "      agreement emailed; el link abre /inspect/<token> en el teléfono."
echo "    • En el teléfono: confirmar -> cambiar vistas -> dot + foto + nota -> Finish."
echo "    • Con el setting OFF -> step 4 EXACTAMENTE como antes (QR)."
