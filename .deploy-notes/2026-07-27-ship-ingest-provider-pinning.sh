#!/usr/bin/env bash
# ============================================================================
# SHIP: internal /ingest provider-account pinning. 2026-07-27. MONEY-ADJACENT.
#
# ROOT CAUSE (QA 2026-07-27): the internal POST /api/tolls/ingest push (droplet
# scrapers — SunPass camoufox) called createManualTransactions WITHOUT a
# providerAccountId, so the pipeline fell back to resolveActiveProvider = "most
# recently updated account". When the TollBridge account was created (19:33),
# it became "most recent", so every SunPass droplet push after that was
# mis-attributed to the TollBridge account AND imported unstamped (the
# multi-account safety correctly refused to guess a sede). Result: 202 Miami
# SunPass tolls appeared under provider=TOLLBRIDGE. No money impact (dedup +
# tenant-wide match intact, no false LAX stamp), but wrong provider attribution.
#
# FIX (route-only, back-compat):
# - New pure helper tolls-ingest-provider.js: providerForIngest({provider,
#   sourceType}) -> explicit provider wins, else infer from sourceType
#   (SUNPASS_SYNC->SUNPASS, AUTOEXPRESO_SYNC->AUTOEXPRESO, TOLLBRIDGE_POLL->
#   TOLLBRIDGE), else null. No imports (unit-testable, no prisma).
# - /ingest now accepts provider?/providerAccountId?, resolves the tenant's
#   account for that provider, and PINS it via options.providerAccountId. No
#   matching account -> unpinned (legacy resolution) so a push is never dropped.
# - The current SunPass droplet already sends sourceType=SUNPASS_SYNC, so this
#   fixes it with NO droplet change; a future droplet may send provider
#   explicitly. Existing pushes without either field keep working.
#
# NOT flagged/dormant: takes effect on deploy (that's the intent). No schema, no
# migration, no new env keys.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/tolls/tolls-ingest-provider.js"
  "backend/src/modules/tolls/tolls-ingest-provider.test.mjs"
  "backend/src/modules/tolls/tolls.routes.js"
  "backend/package.json"
  ".deploy-notes/2026-07-27-ship-ingest-provider-pinning.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/tolls/tolls-ingest-provider.js
node --check backend/src/modules/tolls/tolls.routes.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "providerForIngest" backend/src/modules/tolls/tolls.routes.js); echo "route uses helper (>=1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "providerAccountId: pinnedAccountId" backend/src/modules/tolls/tolls.routes.js); echo "route pins account (1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "import { prisma }" backend/src/modules/tolls/tolls-ingest-provider.js || true); echo "helper is import-free (0): $c3"; [ "$c3" -eq 0 ]
c4=$(grep -c "SUNPASS_SYNC: 'SUNPASS'" backend/src/modules/tolls/tolls-ingest-provider.js); echo "sourceType map present (1): $c4"; [ "$c4" -ge 1 ]

echo "== GATE 3: encoding =="
for f in tolls-ingest-provider.js tolls-ingest-provider.test.mjs tolls.routes.js; do
  n=$(tr -dc '\r' < "backend/src/modules/tolls/$f" | wc -c); [ "$n" -eq 0 ] || { echo "CR in $f: $n"; exit 1; }
done
echo "encoding OK"

echo "== GATE 4: tests =="
( cd backend && npm run test:ingest-provider )

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
