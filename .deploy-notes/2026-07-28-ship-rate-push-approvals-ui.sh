#!/usr/bin/env bash
# ============================================================================
# SHIP: rate-push approval queue UI. 2026-07-28. MONEY-ADJACENT (the screen
# where a human authorises price changes on a franchise's live system).
#
# Backend F4 (b834714) queued held repricings and exposed
# GET/POST /rate-push/approvals, but deciding meant calling the API by hand.
# This adds the screen.
#
# New component RatePushApprovalsPanel.jsx (separate file on purpose — the
# Economy panel is already ~670 lines, and this is reusable once NU/MEX/
# Advantage get rate push). Mounted inside EconomyIntegrationPanel above the
# pending-imports pointer.
#
# The table leads with the MONEY — "franchise now" -> "RFM proposes" -> the
# swing, colour-scaled (>=60% warn, >=100% danger) — because that is what the
# decision turns on, not the class code. An optional note is stored with the
# decision. A decided row leaves the list immediately.
#
# No new endpoints, no schema, no env. Prod stays DRY_RUN, so approving here
# only plans the push; nothing reaches the portal until the mode is LIVE.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "frontend/src/components/settings/RatePushApprovalsPanel.jsx"
  "frontend/src/components/settings/EconomyIntegrationPanel.jsx"
  ".deploy-notes/2026-07-28-ship-rate-push-approvals-ui.sh"
)

echo "== GATE 1: JSX parses =="
( cd frontend && for f in src/components/settings/RatePushApprovalsPanel.jsx src/components/settings/EconomyIntegrationPanel.jsx; do
  node -e "
const { transformSync } = require('next/dist/build/swc');
const fs = require('fs');
transformSync(fs.readFileSync('$f','utf8'), { jsc: { parser: { syntax: 'ecmascript', jsx: true } } });
console.log('JSX OK $f');
"
done )

echo "== GATE 2: structural greps =="
c1=$(grep -c "rate-push/approvals" frontend/src/components/settings/RatePushApprovalsPanel.jsx); echo "queue + decide endpoints used (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "RatePushApprovalsPanel" frontend/src/components/settings/EconomyIntegrationPanel.jsx); echo "mounted in the Economy panel (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "decision: 'approve'\|'approve'" frontend/src/components/settings/RatePushApprovalsPanel.jsx); echo "approve/reject wired (>=1): $c3"; [ "$c3" -ge 1 ]
# The screen must never invent a mode — going LIVE stays an env decision.
c4=$( (grep -c "LIVE" frontend/src/components/settings/RatePushApprovalsPanel.jsx || true) ); echo "UI cannot switch to LIVE (0): $c4"; [ "$c4" -eq 0 ]

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < frontend/src/components/settings/RatePushApprovalsPanel.jsx | wc -c); [ "$n" -eq 0 ] || { echo "CR in panel: $n"; exit 1; }
n=$(tr -dc '\r' < frontend/src/components/settings/EconomyIntegrationPanel.jsx | wc -c); [ "$n" -eq 0 ] || { echo "CR in economy panel: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
( cd frontend && npm test )

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
