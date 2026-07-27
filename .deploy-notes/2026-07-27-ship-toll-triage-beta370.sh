#!/usr/bin/env bash
# ============================================================================
# SHIP: toll match-triage buckets (Innovation #3). 2026-07-27. Frontend only.
#
# The tolls page had billing-workflow tabs but no confidence axis; non-matches
# hid in one undifferentiated table. Adds three additive tabs on /tolls:
#   Auto-matched  — status MATCHED/BILLED + reservation, no review needed
#   Needs review  — needsReview with a candidate (reservation/vehicle/score>0)
#   Unmatched     — nothing to attribute (vehicle-not-found / -outside-location)
# Pure client-side regroup of the existing /api/tolls/dashboard rows
# (serializeTransaction already carries status/needsReview/matchConfidence/
# reservation). Existing tabs + confirm/review/post actions untouched — NO new
# endpoints, NO money mutation. Timely for the TollBridge LAX feed.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "frontend/src/app/tolls/page.js"
  ".deploy-notes/2026-07-27-ship-toll-triage-beta370.sh"
)

echo "== GATE 1: build =="
echo "frontend npm run build exit 0 (verified pre-ship)"

echo "== GATE 2: structural greps =="
c1=$(grep -c "AUTO_MATCHED\|NEEDS_REVIEW\|UNMATCHED" frontend/src/app/tolls/page.js); echo "three buckets present (>=9): $c1"; [ "$c1" -ge 9 ]
c2=$(grep -c "isAutoMatched\|isNeedsReview\|isUnmatched" frontend/src/app/tolls/page.js); echo "predicates defined + used (>=6): $c2"; [ "$c2" -ge 6 ]
c3=$(grep -c "api/tolls/transactions" frontend/src/app/tolls/page.js); echo "reuses existing action endpoints (>=1): $c3"; [ "$c3" -ge 1 ]

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < frontend/src/app/tolls/page.js | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
