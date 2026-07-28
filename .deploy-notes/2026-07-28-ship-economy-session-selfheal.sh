#!/usr/bin/env bash
# ============================================================================
# SHIP: Economy (RezLight) session self-heal. 2026-07-28.
#
# INCIDENT (2026-07-28): RezLight killed the session server-side at 07:53 UTC
# but kept answering HTTP 200. isLoginBounce (401/403/3xx-only) could not see
# it, the dead cookie stayed in the in-memory jar, and every 15-min sync run
# "completed OK" importing ZERO for 6+ hours (recordsTotal:null, accumulated:0).
# Only symptom: one Sentry warn at 10:08 (non-JSON variant). Manual worker
# restart at 14:14 restored it (fresh login -> recordsTotal 94,931 immediately).
#
# FIX (3 pieces, no schema/env/deps):
# - isDeadLookupResponse(json): healthy GetReservationLookupRecords ALWAYS has
#   numeric recordsTotal (empty account = 0, not missing) -> body without it =
#   dead session despite HTTP 200. Pure, exported, tested.
# - fetchReservationList page-0 self-heal: dead response -> clearSession +
#   fresh login + fresh anti-CSRF token + retry ONCE; still dead -> throw
#   EconomyAuthExpiredError (loud AUTH_EXPIRED run, Sentry) — never a silent 0.
# - worker catch(EconomyAuthExpiredError): clearSession(tenantId) so the NEXT
#   run starts with a fresh login instead of reusing the poisoned jar.
# Net: today's incident would self-repair in the SAME run; worst case 15 min
# gap, not 6 hours.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/integrations/economy/economy.service.js"
  "backend/src/modules/integrations/economy/economy.worker.js"
  "backend/src/modules/integrations/economy/economy.test.mjs"
  ".deploy-notes/2026-07-28-ship-economy-session-selfheal.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/integrations/economy/economy.service.js
node --check backend/src/modules/integrations/economy/economy.worker.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "isDeadLookupResponse" backend/src/modules/integrations/economy/economy.service.js); echo "detector present (>=3): $c1"; [ "$c1" -ge 3 ]
c2=$(grep -c "session self-heal succeeded" backend/src/modules/integrations/economy/economy.service.js); echo "heal log line (1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "clearSession(tenantId)" backend/src/modules/integrations/economy/economy.worker.js); echo "worker clears jar on expiry (>=1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "still has no recordsTotal after re-login" backend/src/modules/integrations/economy/economy.service.js); echo "loud throw after failed heal (1): $c4"; [ "$c4" -ge 1 ]

echo "== GATE 3: encoding =="
for f in economy.service.js economy.worker.js economy.test.mjs; do
  n=$(tr -dc '\r' < "backend/src/modules/integrations/economy/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:economy )

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
