#!/usr/bin/env bash
# S30 — smart lookup de confirmación (matcher compartido + endpoint VozIA).
#   S30_SHIP_TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-19-ship-smart-lookup-beta331.sh
#
# BACKEND ONLY, SIN migración, SIN keys nuevas.
#
# QUÉ:
#   - backend/src/lib/reservation-smart-match.js: EL matcher compartido
#     (contrato congelado con el kiosk team en doc/kiosk-smart-lookup-*.md).
#     Variantes por prefijo de booking-source (RES-/TL-/NU-/ECON-/FW-/ADV-)
#     + fallback nombre+ventana. Read-only, tenant-scoped duro.
#   - GET /api/reservations/smart-lookup (ANTES de /:id): gate de privacidad
#     server-side — match no-exacto vuelve ENMASCARADO (maskedName+pickupDate)
#     hasta verificar apellido COMPLETO o fecha exacta de pickup. Exact = el
#     caller ya tiene el número → unmask directo.
#   - Allowlist: entrada read-only explícita + tests.
#   - KIOSK WIRE-IN: backend/src/modules/kiosk/kiosk-smart-match.js (seam de
#     B3g, shipeado dark en beta.330) conecta el matcher real — una lambda
#     que inyecta prisma. El kiosk gana variant-matching en find_reservation.
#   - VERIFY-PROBE THROTTLE (residual de Innovation): un caller scripteado
#     podía brute-forcear el gate (~10 probes de verifyPickupDate cubren la
#     ventana default de 31d con tolerancia ±1d). Nuevo
#     backend/src/lib/verify-probe-throttle.js: contador Redis fixed-window
#     por (tenant, principal) — 10 verify FALLIDOS / 10 min → 429. Lookups
#     sin verify params, exact y verificados NUNCA cuentan. Fail-OPEN con
#     timeout duro de 75ms por op (lección beta.211). Self-contained a
#     propósito (NO importa de tenant-rate-limit.js — ese middleware tiene
#     diff de otro workstream sin commitear y NO va en este FILES[]).
#     El matcher (reservation-smart-match.js) NO cambió — contrato kiosk
#     intacto.
#
# DEPLOY (BACKEND ONLY):
#   git fetch --tags && git checkout $TAG
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${S30_SHIP_TAG:?Set S30_SHIP_TAG=v0.9.0-beta.NNN before running}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
git diff --cached --quiet || { echo "Index is not clean — git reset first" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

node --check backend/src/lib/reservation-smart-match.js
node --check backend/src/modules/reservations/reservations.routes.js
node --check backend/src/lib/service-account-allowlist.js

node --check backend/src/modules/kiosk/kiosk-smart-match.js
node --check backend/src/lib/verify-probe-throttle.js
node --test backend/src/lib/reservation-smart-match.test.mjs
node --test backend/src/lib/verify-probe-throttle.test.mjs
( cd backend && node --test src/lib/service-account-allowlist.test.mjs )
export DATABASE_URL="${DATABASE_URL:-postgresql://$(whoami)@localhost:5432/fleet_management}"
( cd backend && npm run test:service-auth && npm run test:reservations && npm run test:kiosk )

FILES=(
  backend/src/lib/reservation-smart-match.js
  backend/src/lib/reservation-smart-match.test.mjs
  backend/src/modules/reservations/reservations.routes.js
  backend/src/lib/service-account-allowlist.js
  backend/src/lib/service-account-allowlist.test.mjs
  backend/src/modules/kiosk/kiosk-smart-match.js
  backend/src/lib/verify-probe-throttle.js
  backend/src/lib/verify-probe-throttle.test.mjs
  doc/kiosk-smart-lookup-prompt-2026-07-19.md
  .deploy-notes/2026-07-19-ship-smart-lookup-beta331.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done
# ⚠️ reservations.routes.js es compartido — correr SOLO con diff limpio de este workstream.
git add -- "${FILES[@]}"
git status --short --branch
git commit -m "feat(reservations): S30 — smart confirmation lookup (shared matcher + masked-until-verified endpoint)

OTAs hand guests the bare source ref (Expedia: ZE40809640BA) while imports
store it prefixed (TL-ZE40809640BA). New shared matcher lib (frozen contract
with the kiosk workstream) generates prefix variants across all 6 sources +
name-window fallback; read-only, hard tenant scope. GET /smart-lookup gates
privacy SERVER-SIDE: non-exact matches return a masked stub until the caller
proves the full last name or exact pickup date — a common name can never pull
someone else's reservation through Chloe. Allowlist read-only entry + tests. The kiosk B3g seam (beta.330, dark)
is wired live — find_reservation gains variant matching from the same lib.

Verify-probe throttle (Innovation residual): a scripted caller could
brute-force the verify gate — ~10 verifyPickupDate probes cover the default
31-day window at the matcher's ±1-day tolerance. New per-principal Redis
fixed-window counter over FAILED verify attempts (10 per 10 min -> 429);
verified/exact lookups and lookups without verify params never count.
Fail-open with a hard 75ms per-op timeout (beta.211 lesson); shared across
cluster workers by design. Matcher contract untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
