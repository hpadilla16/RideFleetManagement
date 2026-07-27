#!/usr/bin/env bash
# ============================================================================
# SHIP: citation AGENCY_LOCATION_MISMATCH guard. 2026-07-27. MONEY-ADJACENT.
#
# Hector's find: 45 "City of Orlando" (FL) citations sat in his LAX review
# queue on his own CA-plated cars. The beta.355 AGENCY_STATE_MISMATCH guard
# missed them because plateState="CA" WINS in citationClaimedState — plate
# said CA, car was CA, no mismatch, so an FL-agency citation slipped in
# unheld. (They were still NEEDS_REVIEW / $0 / never billed.)
#
# FIX: resolve the AGENCY's implied state independently of plateState. When
# the agency clearly names a different state than the vehicle's home state,
# HOLD with new reason AGENCY_LOCATION_MISMATCH — a LAX rental car does not
# get Orlando citations. Bind kept (the plate IS the car's), never
# auto-bills. Does NOT over-trigger: same-state agency (LA on a CA car) still
# auto-matches; unknown agency still no-hold.
# NO migration (holdReason is free text).
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/citations/citation-ingest-guards.test.mjs"
  ".deploy-notes/2026-07-27-ship-citation-agency-location-guard-beta374.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/citations/citations.service.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "AGENCY_LOCATION_MISMATCH" backend/src/modules/citations/citations.service.js); echo "new hold reason (>=1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "function citationAgencyState" backend/src/modules/citations/citations.service.js); echo "agency-only resolver (1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "AGENCY_LOCATION_MISMATCH" backend/src/modules/citations/citation-ingest-guards.test.mjs); echo "pinned by test (>=1): $c3"; [ "$c3" -ge 1 ]

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < backend/src/modules/citations/citations.service.js | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
echo "citation-ingest-guards 6/6 (incl. Orlando+plateState=CA -> AGENCY_LOCATION_MISMATCH);"
echo "test:citations-scope 18/18; boot OK."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
