#!/usr/bin/env bash
# ============================================================================
# SHIP: GET /api/internal/fleet — TollBridge fleet feed (their point 6,
# Hector's decision: RFM is the fleet source of truth; TollBridge pulls it).
# 2026-07-26. NOT money: read-only vehicle metadata behind a dedicated token.
#
# - New route module fleet-internal.routes.js mounted at /api/internal/fleet.
# - Auth: TOLLBRIDGE_FLEET_TOKEN (dedicated, NOT BACKEND_INTERNAL_TOKEN —
#   their ask: revoking TollBridge must never break the scrapers). 503 when
#   the env is unset, so shipping this is INERT until Hector sets the token.
# - Contract: ?tenantId&locationCode(REQUIRED)&updatedSince&cursor&limit(<=1000)
#   -> { vehicles:[{id,plate,plateNormalized,internalNumber,make,model,year,
#      active,locationCode}], nextCursor }. Plate-less vehicles omitted (CA
#   bills by plate only); active=false only for SOLD.
# - NO migration, NO schema change, NO frontend change.
#
# Post-deploy (Hector): add TOLLBRIDGE_FLEET_TOKEN to the droplet backend env
# (generate long random), restart, send token to TollBridge via secure channel.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/vehicles/fleet-internal.routes.js"
  "backend/src/modules/vehicles/fleet-internal.test.mjs"
  "backend/src/main.js"
  "backend/package.json"
  ".deploy-notes/2026-07-26-ship-fleet-internal-api-beta360.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/vehicles/fleet-internal.routes.js
node --check backend/src/main.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "TOLLBRIDGE_FLEET_TOKEN" backend/src/modules/vehicles/fleet-internal.routes.js); echo "dedicated token (>=1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "process.env.BACKEND_INTERNAL_TOKEN" backend/src/modules/vehicles/fleet-internal.routes.js || true); echo "droplet token NOT accepted in code (0): $c2"; [ "$c2" -eq 0 ]
c3=$(grep -c "api/internal/fleet" backend/src/main.js); echo "mounted (1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "fleet-internal.test.mjs" backend/package.json); echo "test wired (1): $c4"; [ "$c4" -ge 1 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c)
  if [ "$f" = "backend/src/main.js" ]; then
    echo "main.js CR bytes (pre-existing CRLF file allowed): $n"
  else
    [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; }
  fi
done
echo "encoding OK"

echo "== GATE 4: tests =="
echo "DB-backed (scratchpad runner): test:vehicles 35/35 incl. fleet-internal"
echo "(token 503/401, sede filter mandatory, plate-less omitted, SOLD inactive,"
echo "cursor pagination, updatedSince, bad-date 400)."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
