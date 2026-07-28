#!/usr/bin/env bash
# ============================================================================
# SHIP: OUTBOUND rate push — F2 (portal client + orchestration).
# 2026-07-28. MONEY-ADJACENT (writes prices into a franchise's live system).
#
# Builds on F1 (57ddd2d: audit model + pure guardrails). Adds the two halves
# that were missing:
#   economy-rate-client.js       transport — read the grid, write ONE cell,
#                                read it back. Per-cell on purpose: the portal
#                                applies currentData across every selected
#                                location/rate/day, so a wide selection would
#                                fan one mistake across the calendar.
#   economy-rate-push.service.js orchestration — load RFM rates (the truth MI
#                                maintains) + the portal's current grid, run
#                                buildPushPlan, then DRY_RUN (record only) or
#                                LIVE (write + VERIFY), auditing every
#                                decision incl. the skips.
#
# STILL DORMANT: ECONOMY_RATE_PUSH_MODE defaults OFF, and even when set an area
# pushes only with ratePushEnabled=true (default false) AND a declared
# rateCloseoutMin. No scheduler and no route yet — F3 wires the triggers — so
# nothing runs on its own after this deploy.
#
# ROLLOUT: OFF -> DRY_RUN for days (compare RatePushLog PLANNED rows against
# the portal by hand) -> LIVE.
#
# Env (all code-defaulted, no new .env.example keys):
#   ECONOMY_RATE_PUSH_MODE=OFF|DRY_RUN|LIVE   (default OFF)
#   ECONOMY_RATE_PUSH_HORIZON_DAYS=7          (max 90)
#   ECONOMY_RATE_PUSH_MAX_DELTA_PCT=60
#   ECONOMY_RATE_PUSH_PROVIDER=61201
#
# Guardrails proven by tests: no sentinel -> refuse; close-out days preserved
# while neighbours publish; ApplyRates lying about success is caught by the
# read-back and audited MISMATCH; a throwing write is FAILED and does not abort
# the run.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/integrations/economy/economy-rate-client.js"
  "backend/src/modules/integrations/economy/economy-rate-push.service.js"
  "backend/src/modules/integrations/economy/economy-rate-push.test.mjs"
  "backend/package.json"
  ".deploy-notes/2026-07-28-ship-rate-push-f2.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/integrations/economy/economy-rate-client.js
node --check backend/src/modules/integrations/economy/economy-rate-push.service.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -cE "ECONOMY_RATE_PUSH_MODE \|\| 'OFF'" backend/src/modules/integrations/economy/economy-rate-push.service.js); echo "mode defaults OFF (1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "verifyPush" backend/src/modules/integrations/economy/economy-rate-push.service.js); echo "verify-after-write wired (>=1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "rateCloseoutMin == null" backend/src/modules/integrations/economy/economy-rate-push.service.js); echo "sentinel refusal (1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "selectedLocations: JSON.stringify(\[String(location)\])" backend/src/modules/integrations/economy/economy-rate-client.js); echo "single-location write (1): $c4"; [ "$c4" -ge 1 ]
# No scheduler/route may reference the push yet (F3 does that).
# Real IMPORTS only — doc comments naming the memory doc must not trip this.
c5=$( (grep -rnE "from '[^']*economy-rate-push\.service\.js'|import\('[^']*economy-rate-push\.service\.js'\)" backend/src --include="*.js" 2>/dev/null || true) | wc -l); echo "no scheduler/route importer yet (0): $c5"; [ "$c5" -eq 0 ]
c6=$(grep -c "ECONOMY_RATE_PUSH" backend/.env.example || true); echo "no NEW required env.example keys (0): $c6"; [ "$c6" -eq 0 ]

echo "== GATE 3: encoding =="
for f in economy-rate-client.js economy-rate-push.service.js economy-rate-push.test.mjs; do
  n=$(tr -dc '\r' < "backend/src/modules/integrations/economy/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:rate-push )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:rate-push-map )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:economy )

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
