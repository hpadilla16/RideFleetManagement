#!/usr/bin/env bash
# ============================================================================
# SHIP: rate push — F4 APPROVAL QUEUE. 2026-07-28. MONEY-ADJACENT.
#
# WHY (Hector, after seeing the first live DRY_RUN): "y entonces si que pregunte
# por aprobacion". The delta band (60%) correctly held 4 LAX classes — the
# franchise sits at $11-16 against RFM's $20-32 (+82% to +104%) — but a held
# move was merely SKIPPED into the log where nobody would ever see it. A large
# repricing is a business decision, so it must ASK, not vanish.
#
# Now an out-of-band cell is recorded PENDING_APPROVAL carrying the value it
# WOULD publish (intendedValue — so the queue reads "$11 -> $20" instead of the
# old "-> $0" placeholder, which was itself misleading). A human approves or
# rejects; an APPROVED row authorises exactly ONE push of that
# (class, date, value) on the next sweep and is consumed by it — one row spans
# the whole lifecycle PENDING_APPROVAL -> APPROVED -> SENT -> VERIFIED.
#
# AN APPROVAL IS NOT A SKELETON KEY. It bypasses the DELTA BAND for that one
# cell and nothing else (all pinned by tests): it can never re-open a close-out,
# publish a zero, create a close-out, or run without a declared sentinel. And
# the match is strict on class + date + VALUE, so if RFM's rate moves after
# sign-off the stale approval does NOT carry the new number through — it
# returns to the queue.
#
# Queue hygiene: the sweep runs every 30 min, so an identical pending row is
# not duplicated; a pending row for a DIFFERENT target is superseded rather
# than left competing.
#
# Routes: GET /rate-push/approvals (queue with from/to/deltaPct),
#         POST /rate-push/approvals/:id { decision: 'approve'|'reject', note? }
#         — only a PENDING row can be decided, so a decision can never be
#         replayed onto an already-sent push.
#
# Migration additive: 3 nullable columns + a PARTIAL index on the
# pending/approved slice (the audit table is large and append-only).
# Still DRY_RUN in prod; approvals only take effect once mode is LIVE.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260728_rate_push_approval/migration.sql"
  "backend/src/modules/integrations/economy/economy-rate-map.js"
  "backend/src/modules/integrations/economy/economy-rate-map.test.mjs"
  "backend/src/modules/integrations/economy/economy-rate-push.service.js"
  "backend/src/modules/integrations/economy/economy-rate-push.test.mjs"
  "backend/src/modules/integrations/economy/economy.routes.js"
  ".deploy-notes/2026-07-28-ship-rate-push-f4-approvals.sh"
)

echo "== GATE 1: syntax + schema + boot import =="
node --check backend/src/modules/integrations/economy/economy-rate-map.js
node --check backend/src/modules/integrations/economy/economy-rate-push.service.js
node --check backend/src/modules/integrations/economy/economy.routes.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" npx prisma validate )
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "PENDING_APPROVAL" backend/src/modules/integrations/economy/economy-rate-push.service.js); echo "queues held moves (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "isApproved" backend/src/modules/integrations/economy/economy-rate-map.js); echo "approval matcher wired (>=2): $c2"; [ "$c2" -ge 2 ]
# The band is the ONLY guard an approval may bypass.
c3=$(grep -c "if (!approved && current !== null" backend/src/modules/integrations/economy/economy-rate-map.js); echo "approval bypasses band only (1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "status: 'PENDING_APPROVAL'" backend/src/modules/integrations/economy/economy.routes.js); echo "decide requires PENDING (>=1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "intendedValue" backend/src/modules/integrations/economy/economy-rate-map.js); echo "held rows carry the intended value (>=1): $c5"; [ "$c5" -ge 1 ]

echo "== GATE 3: encoding =="
for f in economy-rate-map.js economy-rate-map.test.mjs economy-rate-push.service.js economy-rate-push.test.mjs economy.routes.js; do
  n=$(tr -dc '\r' < "backend/src/modules/integrations/economy/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260728_rate_push_approval/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "NON-ASCII in migration: $n"; exit 1; }
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
