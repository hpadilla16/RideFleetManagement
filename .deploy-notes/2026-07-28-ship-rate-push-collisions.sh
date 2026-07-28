#!/usr/bin/env bash
# ============================================================================
# SHIP: rate-push — class COLLISION resolution. 2026-07-28. MONEY-ADJACENT.
#
# BUG THIS FIXES (found by Hector's "SFAR y IFAR son los mismos"): buildPushPlan
# mapped each RFM class independently, so two RFM classes aliasing onto ONE
# portal class produced TWO writes to the same (class, date) cell. RFM carries
# IFAR ($32.67) AND SFAR ($57.33) while the LAX portal offers only IFAR — the
# cell would have been written twice with different prices and the LAST one
# would have won arbitrarily. A $24.66/day coin flip.
#
# RULE (Hector 2026-07-28: "el de IFAR"): the class matching the portal code by
# IDENTITY owns the cell; aliases that lose are recorded SKIPPED/collision_lost
# rather than silently dropped. With NO identity claimant the winner is a
# business decision, so we publish NOTHING and flag every contender
# collision_unresolved — the code never guesses a price.
#
# Note this makes SFAR's status explicit either way: unmapped it is
# no_class_map (Hector's standing decision to leave it out), aliased it is
# collision_lost. Both stay visible in GET /rate-push/log.
#
# Still dormant (ECONOMY_RATE_PUSH_MODE=OFF). Pure-library change; no schema,
# env, route or scheduler change.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/integrations/economy/economy-rate-map.js"
  "backend/src/modules/integrations/economy/economy-rate-map.test.mjs"
  ".deploy-notes/2026-07-28-ship-rate-push-collisions.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/integrations/economy/economy-rate-map.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "COLLISION_LOST" backend/src/modules/integrations/economy/economy-rate-map.js); echo "loser recorded (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "COLLISION_UNRESOLVED" backend/src/modules/integrations/economy/economy-rate-map.js); echo "ambiguity fail-closed (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "contenders.find((r) => String(r.classCode).toUpperCase() === portalClass)" backend/src/modules/integrations/economy/economy-rate-map.js); echo "identity-wins rule (1): $c3"; [ "$c3" -ge 1 ]

echo "== GATE 3: encoding =="
for f in economy-rate-map.js economy-rate-map.test.mjs; do
  n=$(tr -dc '\r' < "backend/src/modules/integrations/economy/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:rate-push-map )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:rate-push )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:economy )

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
