#!/usr/bin/env bash
# ============================================================================
# SHIP: internal /ingest per-provider kill-switch. 2026-07-27. MONEY-ADJACENT.
#
# Follow-up to the /ingest provider-pinning fix. Lets RFM REJECT pushes for
# named providers at the internal ingest endpoint, to cut off a misbehaving
# external scraper (the SunPass camoufox droplet flooding /ingest with FL tolls)
# WITHOUT rotating the shared BACKEND_INTERNAL_TOKEN (which would also break
# every other legit internal push).
#
# - New pure helper parseDisabledIngestProviders(csv) -> Set<UPPER provider>.
# - /ingest computes wantProvider (explicit provider | inferred from sourceType)
#   once, then: if wantProvider is in TOLLS_INGEST_DISABLED_PROVIDERS, return
#   202 {skipped:true} WITHOUT ingesting (202 so the pusher treats it as
#   accepted-not-stored, not an error to retry-storm). Otherwise pin the account
#   and ingest as before.
# - TOLLS_INGEST_DISABLED_PROVIDERS is code-defaulted (empty = nothing blocked),
#   so env-diff-check stays green (no new required .env.example key).
#
# ACTIVATION (Hector, droplet): set TOLLS_INGEST_DISABLED_PROVIDERS=SUNPASS in
# backend/.env for the BACKEND container (the API serves /ingest, not the
# worker) and recreate it. Clear the value to re-enable SunPass ingest. Reversible.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/tolls/tolls-ingest-provider.js"
  "backend/src/modules/tolls/tolls-ingest-provider.test.mjs"
  "backend/src/modules/tolls/tolls.routes.js"
  ".deploy-notes/2026-07-27-ship-ingest-sunpass-killswitch.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/tolls/tolls-ingest-provider.js
node --check backend/src/modules/tolls/tolls.routes.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "parseDisabledIngestProviders" backend/src/modules/tolls/tolls.routes.js); echo "route uses kill-switch helper (>=1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "TOLLS_INGEST_DISABLED_PROVIDERS" backend/src/modules/tolls/tolls.routes.js); echo "reads env flag (>=1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "status(202)" backend/src/modules/tolls/tolls.routes.js); echo "202 skip response (>=1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "TOLLS_INGEST_DISABLED_PROVIDERS" backend/.env.example || true); echo "no NEW required env.example key (0): $c4"; [ "$c4" -eq 0 ]

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
