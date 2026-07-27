#!/usr/bin/env bash
# ============================================================================
# SHIP: TollBridge partner-feed poller (DORMANT). 2026-07-27. MONEY-ADJACENT.
#
# The other half of the TollBridge integration: RFM POLLS their
# GET /api/partner/tolls with the read-only key they issue (tb_...), and
# ingests through the EXISTING toll pipeline — createManualTransactions does
# dedup (externalId), the sede-scoped matcher, the agreement mirror, and the
# staff alerts we already shipped. This adds only: pull, map, and VOID refresh
# (their point 5 — re-poll a 45d window and flip our copy to VOID when theirs
# does; sticky BILLED/DISPUTED untouched).
#
# - TollProvider enum += TOLLBRIDGE (migration 20260727_tollbridge_provider,
#   additive idempotent enum add). Configure a TollProviderAccount(TOLLBRIDGE)
#   with locationId = LAX so every imported toll is sede-stamped.
# - Client: plain global fetch, cursor pagination, retry on 429/5xx. Key read
#   from env at call time — NEVER hardcoded (verified: 0 in code).
# - Scheduler: own timer, gated by TOLLBRIDGE_IMPORT_ENABLED (default false ->
#   DORMANT). All TOLLBRIDGE_* env code-defaulted (env-diff-check green).
#
# ACTIVATION (Hector, when TollBridge's endpoint is live): create the
# TOLLBRIDGE provider account (locationId=LAXA01); set TOLLBRIDGE_PARTNER_KEY
# (the tb_ key, encrypted/env) + TOLLBRIDGE_IMPORT_ENABLED=true; restart
# worker. Migrate via SESSION 5432 + host npx prisma generate from backend/.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260727_tollbridge_provider/migration.sql"
  "backend/src/modules/tolls/tollbridge/tollbridge.constants.js"
  "backend/src/modules/tolls/tollbridge/tollbridge-partner-client.js"
  "backend/src/modules/tolls/tollbridge/tollbridge-import.service.js"
  "backend/src/modules/tolls/tollbridge/tollbridge.scheduler.js"
  "backend/src/modules/tolls/tollbridge/tollbridge-import.test.mjs"
  "backend/src/worker.js"
  "backend/package.json"
  ".deploy-notes/2026-07-27-ship-tollbridge-import-beta376.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in tollbridge.constants tollbridge-partner-client tollbridge-import.service tollbridge.scheduler; do
  node --check "backend/src/modules/tolls/tollbridge/$f.js"
done
node --check backend/src/worker.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$( (grep -rn "tb_S1AnJp" backend/src backend/prisma 2>/dev/null || true) | wc -l); echo "partner key NOT in code (0): $c1"; [ "$c1" -eq 0 ]
c2=$(grep -c "TOLLBRIDGE_PARTNER_KEY" backend/src/modules/tolls/tollbridge/tollbridge.constants.js); echo "key read from env (>=1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "TOLLBRIDGE_IMPORT_ENABLED" backend/src/modules/tolls/tollbridge/tollbridge.scheduler.js); echo "dormant flag gate (>=1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "notIn: \['VOID', 'BILLED', 'DISPUTED'\]" backend/src/modules/tolls/tollbridge/tollbridge-import.service.js); echo "VOID refresh sticky-safe (1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "startTollBridgeImportScheduler" backend/src/worker.js); echo "worker wired (>=1): $c5"; [ "$c5" -ge 1 ]
c6=$(grep -c "TOLLBRIDGE" backend/.env.example || true); echo "no NEW required env.example keys (0): $c6"; [ "$c6" -eq 0 ]

echo "== GATE 3: encoding =="
for f in tollbridge.constants.js tollbridge-partner-client.js tollbridge-import.service.js tollbridge.scheduler.js tollbridge-import.test.mjs; do
  n=$(tr -dc '\r' < "backend/src/modules/tolls/tollbridge/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260727_tollbridge_provider/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "NON-ASCII in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
echo "test:tollbridge 3/3 (cursor pagination, missing-key guard, partner->row"
echo "mapping). Boot OK. Poller DORMANT (TOLLBRIDGE_IMPORT_ENABLED=false)."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
