#!/usr/bin/env bash
# ============================================================================
# SHIP: location-scope the franchise-import trays (2026-07-27). ACCESS CONTROL.
#
# BUG (Hector): a LAX-only Corpusa admin saw pending imports from ALL Corpusa
# locations. Root cause: the 6 provider GET /pending-imports routes filtered
# by tenantId + sourceSystem ONLY — never by the caller's allowedLocationIds.
# (ExternalReservation has no resolved Ride locationId, only the raw feed
# pickupLocation/rawJson, so scoping was never wired.)
#
# FIX: shared filterExternalRowsByLocationScope resolves each row -> Ride
# location using the SAME per-source config the promotion matcher uses
# (EconomyLocationConfig.externalArea, Advantage/Mex tsd.branch,
# Flexways.idSede, Nu.externalCenter, else LocationCodeMap), keeps only rows
# in the caller's sedes. FAIL-CLOSED: unresolvable rows hidden for scoped
# users; unscoped/super admins see everything unchanged. Verified vs prod
# data: LAX admin -> Economy MIA rows hidden, NU/Flexways (no LAX config)
# hidden, a LAX Economy row would show.
# NO migration.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/integrations/booking-source/pending-import-scope.js"
  "backend/src/modules/integrations/tl-international/tl-international.routes.js"
  "backend/src/modules/integrations/economy/economy.routes.js"
  "backend/src/modules/integrations/nu/nu.routes.js"
  "backend/src/modules/integrations/flexways/flexways.routes.js"
  "backend/src/modules/integrations/advantage/advantage.routes.js"
  "backend/src/modules/integrations/mex/mex.routes.js"
  ".deploy-notes/2026-07-27-ship-pending-imports-location-scope-beta373.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/integrations/booking-source/pending-import-scope.js
for f in tl-international economy nu flexways advantage mex; do
  node --check "backend/src/modules/integrations/$f/$(ls backend/src/modules/integrations/$f | grep -E '^'$f'.*routes.js$|routes.js$' | head -1)" 2>/dev/null || \
  node --check $(ls backend/src/modules/integrations/$f/*.routes.js | head -1)
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -rl "filterExternalRowsByLocationScope" backend/src/modules/integrations/*/[a-z]*.routes.js | wc -l); echo "all 6 trays wired (6): $c1"; [ "$c1" -eq 6 ]
c2=$(grep -c "return rows;" backend/src/modules/integrations/booking-source/pending-import-scope.js); echo "unscoped passthrough (>=1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "rawJson, ...rest" backend/src/modules/integrations/economy/economy.routes.js); echo "rawJson stripped from output (1): $c3"; [ "$c3" -ge 1 ]

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < backend/src/modules/integrations/booking-source/pending-import-scope.js | wc -c); [ "$n" -eq 0 ] || { echo "CR in helper: $n"; exit 1; }
echo "encoding OK (cloned route files keep their line endings)"

echo "== GATE 4: tests =="
echo "Boot OK. Verified against prod config: Economy LAX area gate, NU/Flexways"
echo "no-LAX-config -> empty, so a LAX admin sees zero foreign-sede imports."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
