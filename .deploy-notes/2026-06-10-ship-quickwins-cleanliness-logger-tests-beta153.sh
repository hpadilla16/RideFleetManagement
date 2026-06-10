#!/usr/bin/env bash
# v0.9.0-beta.153 — QUICK WINS (4 fixes chicos, cero money):
#   bash .deploy-notes/2026-06-10-ship-quickwins-cleanliness-logger-tests-beta153.sh
#
# CODE-ONLY — NO migration. Backend + Frontend. Stacks on beta.152
# (release/deposit-balance-fix-beta119). ZERO money code.
#
# QUÉ ENTRA:
#   1. CLEANLINESS EN CHECKOUT MÓVIL — la página móvil nunca capturaba
#      cleanliness, así que TODOS los checkouts v2 imprimían "-" en el contrato
#      (limitación conocida de beta.152). La página ahora tiene un select 1..5
#      (misma escala del wizard desktop) y el complete() lo escribe en
#      RentalAgreement.cleanlinessOut SOLO si la columna está null (el valor del
#      agente en desktop siempre gana). Sin migración: la columna ya existe.
#      NOTA: cleanlinessOut alimenta computeCleaningFee() al check-in — este fix
#      NO toca el fee engine, solo captura el dato igual que el desktop.
#   2. LOGGER redactSensitive — 'name' salía de REDACT_KEYS incondicional y
#      enmascaraba nombres NO-PII (vehicle/tenant/location). Ahora name/fullname
#      se redactan SOLO si el mismo objeto trae contexto de persona (email,
#      phone, dob, license, ssn, customerId...). Backed por 11 unit tests nuevos
#      (npm run test:logger, sin prisma).
#   3. test:rental-agreements con --test-force-exit — ya no se cuelga en el Mac
#      al correr ambos archivos juntos (handle de prisma abierto). Verificado:
#      pasa Y sale solo. (Investigar el handle queda abierto, esto es el gate.)
#   4. backfill-v2-checkout-mileage.mjs (NUEVO script, NO corre en deploy) —
#      rellena los VehicleMileageEntry CHECKOUT que la cascada v2 saltó antes de
#      beta.152 (lee la fila de inspección; el backfill de beta.143 no los veía
#      porque leía agreement.odometerOut que estaba null). Idempotente, dry-run
#      por default, history-only (no toca Vehicle.mileage ni odometerOut).
#
# FILES:
#   frontend/src/app/checkout/mobile/[token]/page.js                    (select cleanliness + body)
#   backend/src/modules/checkout-session/mobile-inspection.routes.js    (passthrough cleanliness)
#   backend/src/modules/checkout-session/mobile-inspection.service.js   (write-through if null)
#   backend/src/lib/logger.js                                           (name condicional por contexto)
#   backend/src/lib/logger-redact.test.mjs                              (NUEVO — 11 tests)
#   backend/scripts/backfill-v2-checkout-mileage.mjs                    (NUEVO — correr a mano post-deploy)
#   backend/package.json                                                (test:logger + --test-force-exit)
#   .deploy-notes/2026-06-10-ship-quickwins-cleanliness-logger-tests-beta153.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.153"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/checkout/mobile/[token]/page.js"
  "backend/src/modules/checkout-session/mobile-inspection.routes.js"
  "backend/src/modules/checkout-session/mobile-inspection.service.js"
  "backend/src/lib/logger.js"
  "backend/src/lib/logger-redact.test.mjs"
  "backend/scripts/backfill-v2-checkout-mileage.mjs"
  "backend/package.json"
  ".deploy-notes/2026-06-10-ship-quickwins-cleanliness-logger-tests-beta153.sh"
)

# ── SYNTAX GATE (backend). main.js + worker.js included — logger y
# mobile-inspection están en el import path de ambos.
( cd backend \
  && node --check src/lib/logger.js \
  && node --check src/modules/checkout-session/mobile-inspection.routes.js \
  && node --check src/modules/checkout-session/mobile-inspection.service.js \
  && node --check scripts/backfill-v2-checkout-mileage.mjs \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."

# package.json must stay valid JSON.
( cd backend && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" ) && echo "package.json JSON OK."

# ── UNIT TESTS — logger redaction (nuevo) + rental-agreements (valida que el
# force-exit de verdad sale; si esto se cuelga, el fix #3 no funcionó).
( cd backend && npm run -s test:logger >/dev/null ) && echo "logger unit tests OK."
# (sin `timeout`: macOS no lo trae; --test-force-exit ya garantiza que sale)
( cd backend && npm run -s test:rental-agreements >/dev/null ) && echo "rental-agreements tests OK (and exited)." \
  || { echo "ABORT: rental-agreements tests failed." >&2; exit 1; }

# ── FRONTEND build (la página móvil es client page; el build caza JSX/imports).
( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build failed — run 'cd frontend && npm run build' to see the error." >&2; exit 1; }

# ── GUARDS.
grep -nq "cleanliness" "frontend/src/app/checkout/mobile/[token]/page.js" || { echo "ABORT: mobile page missing cleanliness." >&2; exit 1; }
grep -nq "cleanliness" backend/src/modules/checkout-session/mobile-inspection.routes.js || { echo "ABORT: routes not passing cleanliness." >&2; exit 1; }
grep -nq "cleanlinessOut" backend/src/modules/checkout-session/mobile-inspection.service.js || { echo "ABORT: service missing write-through." >&2; exit 1; }
grep -nq "writeCleanliness = agClean != null && agClean.cleanlinessOut == null" backend/src/modules/checkout-session/mobile-inspection.service.js || { echo "ABORT: only-if-null guard missing." >&2; exit 1; }
grep -nq "PERSON_CONTEXT_KEYS" backend/src/lib/logger.js || { echo "ABORT: logger conditional-name fix missing." >&2; exit 1; }
grep -nq -- "--test-force-exit" backend/package.json || { echo "ABORT: force-exit gate missing." >&2; exit 1; }
grep -nq "test:logger" backend/package.json || { echo "ABORT: test:logger not wired." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix: mobile checkout cleanliness capture + logger name redaction + test gates

- Mobile inspection page now captures cleanliness (1..5, desktop wizard scale)
  and complete() writes it through to RentalAgreement.cleanlinessOut ONLY when
  the column is still null. Closes the known beta.152 limitation (contracts
  printed '-' for Cleanliness Out on every v2 checkout). No fee-engine changes.
- redactSensitive(): 'name'/'fullName' now redact only when the surrounding
  object carries person context (email/phone/dob/license/ssn/customerId...).
  Vehicle/tenant/location display names stay readable in prod logs. 11 unit
  tests (npm run test:logger).
- test:rental-agreements gated with --test-force-exit (open prisma handle hung
  the run when both files ran together; tests pass and now exit).
- New backfill-v2-checkout-mileage.mjs: fills the CHECKOUT mileage entries the
  v2 cascade skipped pre-beta.152, reading the inspection rows. Idempotent,
  dry-run default, history-only. Run manually post-deploy.

Code-only, no migration, no money code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY — no migration, frontend + backend):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "POST-DEPLOY (backfill, a mano, dentro del contenedor):"
echo "  docker exec fleet-backend-prod node scripts/backfill-v2-checkout-mileage.mjs          # dry run"
echo "  docker exec fleet-backend-prod node scripts/backfill-v2-checkout-mileage.mjs --apply  # insertar"
echo
echo "VERIFY: 3 containers healthy + clean boot + /health 200 + HARD refresh."
echo "  smoke:"
echo "    • Checkout móvil de prueba -> el select Cleanliness aparece antes de Notes;"
echo "      al cerrar, el contrato imprime Cleanliness Out (no '-')."
echo "    • Un agreement donde el agente YA puso cleanliness en desktop -> NO cambia."
echo "    • Logs: una línea con vehicle {name} sale legible; customer {name,email} sale [redacted]."
echo "    • Vehicle profile -> mileage history muestra las entradas backfilled (post --apply)."
