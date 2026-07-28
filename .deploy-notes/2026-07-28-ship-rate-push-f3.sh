#!/usr/bin/env bash
# ============================================================================
# SHIP: OUTBOUND rate push — F3 (scheduler + manual run/log routes). CLOSES the
# rate-push arc (F1 57ddd2d model+guardrails, F2 97f071d client+orchestration).
# 2026-07-28. MONEY-ADJACENT.
#
# DESIGN NOTE — why a sweep and NOT an inline hook after MI auto-applies:
# Market Intelligence writes RateItem.daily in the API container, while the
# push runs in the worker, so an in-process signal cannot cross containers; and
# calling the franchise portal inline would couple MI's write path to a slow
# third-party round-trip. Because pushArea skips every cell that already
# matches (`no_change`), a periodic sweep IS both the MI follow-up and the
# drift backstop. The interval is therefore the effective settle window: an MI
# change reaches the franchise within one cycle (default 30 min).
#
# Adds:
#  - economy-rate-push.scheduler.js — own timer + in-progress guard + startup
#    stagger (240s, well behind the reservation sweeps so a boot does not fire
#    every connector at the same portal session). No-op while mode is OFF.
#  - worker.js start/stop wiring, fail-isolated like the other schedulers.
#  - POST /rate-push/run — on-demand run for the rollout. `mode` may only
#    DOWNGRADE the ambient mode (a LIVE deployment can be exercised as DRY_RUN,
#    never the reverse): going live stays an env/deploy decision, never a
#    request body. 409 while OFF.
#  - GET /rate-push/log — recent decisions INCLUDING skips, so an operator can
#    review what was preserved as much as what was written.
#
# STILL DORMANT: ECONOMY_RATE_PUSH_MODE defaults OFF -> the scheduler logs
# "disabled" and the route 409s. Per-area ratePushEnabled (default false) +
# rateCloseoutMin remain required.
#
# ROLLOUT: apply the F1 migration -> ECONOMY_RATE_PUSH_MODE=DRY_RUN -> review
# GET /rate-push/log PLANNED rows against the portal for a few days -> LIVE.
#
# Env (code-defaulted, no new .env.example keys):
#   ECONOMY_RATE_PUSH_INTERVAL_MINUTES=30
#   ECONOMY_RATE_PUSH_STARTUP_DELAY_SECONDS=240
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/integrations/economy/economy-rate-push.scheduler.js"
  "backend/src/modules/integrations/economy/economy-rate-push.test.mjs"
  "backend/src/modules/integrations/economy/economy.routes.js"
  "backend/src/worker.js"
  ".deploy-notes/2026-07-28-ship-rate-push-f3.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/integrations/economy/economy-rate-push.scheduler.js
node --check backend/src/modules/integrations/economy/economy.routes.js
node --check backend/src/worker.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "pushMode() === MODES.OFF" backend/src/modules/integrations/economy/economy-rate-push.scheduler.js); echo "scheduler dormant while OFF (1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "startEconomyRatePushScheduler" backend/src/worker.js); echo "worker start wired (>=1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "stopEconomyRatePushScheduler" backend/src/worker.js); echo "worker stop wired (>=1): $c3"; [ "$c3" -ge 1 ]
# The route must never be able to ESCALATE to LIVE from a request body.
c4=$(grep -c "requested === MODES.DRY_RUN ? MODES.DRY_RUN : ambient" backend/src/modules/integrations/economy/economy.routes.js); echo "route can only downgrade mode (1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "Rate push is OFF" backend/src/modules/integrations/economy/economy.routes.js); echo "route 409s while OFF (1): $c5"; [ "$c5" -ge 1 ]
c6=$(grep -c "ECONOMY_RATE_PUSH" backend/.env.example || true); echo "no NEW required env.example keys (0): $c6"; [ "$c6" -eq 0 ]

echo "== GATE 3: encoding =="
for f in economy-rate-push.scheduler.js economy-rate-push.test.mjs economy.routes.js; do
  n=$(tr -dc '\r' < "backend/src/modules/integrations/economy/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
n=$(tr -dc '\r' < backend/src/worker.js | wc -c); [ "$n" -eq 0 ] || { echo "CR in worker.js: $n"; exit 1; }
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
