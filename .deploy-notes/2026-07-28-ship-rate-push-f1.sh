#!/usr/bin/env bash
# ============================================================================
# SHIP: OUTBOUND rate push — F1 (audit model + pure mapping/guardrails).
# 2026-07-28. MONEY-ADJACENT (writes prices into a franchise's live system).
#
# STRATEGY (Hector): the franchise API integrations are months away, but we
# already hold an authenticated portal session (the one importing reservations).
# RezLight exposes a real rate-editing surface, so RFM can publish
# Market-Intelligence-maintained prices TODAY. RFM rates are the source of
# truth; the franchise mirrors them. Economy is the pilot; the seam then clones
# to NU/MEX/Advantage/Flexways.
#
# PROVEN LIVE 2026-07-28 (canary, Hector-authorized): wrote CCAR @ LAXO01
# 2027-03-15 = 33.33 via ApplyRates -> read back 33.33. The write path works.
#
# THIS SHIP IS INERT: schema + a pure decision library + tests. No caller, no
# scheduler, no route. Nothing can push until F2 lands, and even then only for
# an area with ratePushEnabled=true (default false) AND a declared
# rateCloseoutMin (NULL refuses to run).
#
# TWO GUARDRAILS LEARNED THE HARD WAY (both pinned by tests):
#  1. CLOSE-OUTS = 250.00 at LAX. The operator blocks days by pricing them
#     high; overwriting one silently re-opens closed inventory. Never written
#     over, and a push may never CREATE one either.
#  2. ApplyRates returns {"success":true,"message":"The rates have been
#     updated."} EVEN WHEN IT IGNORES THE VALUE (verified: writing "" to clear
#     a cell reported success and changed nothing). The success flag is
#     worthless -> verifyPush() compares a re-read, and that is what decides.
#
# Also fixed here: toAmount('abc') returned 0 (Number('') === 0), i.e. garbage
# text became a FREE RENTAL price. Now null so callers refuse it.
#
# MIGRATION: additive only (new table + nullable columns, all IF NOT EXISTS).
# Apply via SESSION pooler 5432 + host `npx prisma generate` from backend/.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260728_rate_push/migration.sql"
  "backend/src/modules/integrations/economy/economy-rate-map.js"
  "backend/src/modules/integrations/economy/economy-rate-map.test.mjs"
  "backend/package.json"
  ".deploy-notes/2026-07-28-ship-rate-push-f1.sh"
)

echo "== GATE 1: syntax + schema + boot import =="
node --check backend/src/modules/integrations/economy/economy-rate-map.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npx prisma validate )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "CLOSEOUT_PRESERVED" backend/src/modules/integrations/economy/economy-rate-map.js); echo "closeout guard (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "rateCloseoutMin" backend/prisma/schema.prisma); echo "sentinel column (>=1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -cE "ratePushEnabled +Boolean +@default\(false\)" backend/prisma/schema.prisma || true); echo "push flag defaults OFF (1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "model RatePushLog" backend/prisma/schema.prisma); echo "audit model (1): $c4"; [ "$c4" -eq 1 ]
c5=$( (grep -rn "economy-rate-map" backend/src --include="*.js" 2>/dev/null || true) | (grep -v "economy-rate-map.js" || true) | wc -l); echo "INERT — no production caller yet (0): $c5"; [ "$c5" -eq 0 ]

echo "== GATE 3: encoding =="
for f in economy-rate-map.js economy-rate-map.test.mjs; do
  n=$(tr -dc '\r' < "backend/src/modules/integrations/economy/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260728_rate_push/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "NON-ASCII in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:rate-push-map )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npm run test:economy )

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
