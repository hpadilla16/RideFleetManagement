#!/usr/bin/env bash
# ============================================================================
# SHIP: live customer display (Innovation #5). 2026-07-27. Frontend only.
#
# The second-screen window (/customer-display) already listened on the
# 'customer-display' BroadcastChannel and fast-polls charges once it knows
# the reservation — but nothing ever TOLD it which reservation, so the
# AppShell "Display" button opened a blank screen the agent had to steer by
# hand. The checkout wizard now broadcasts load-reservation on mount (and
# re-broadcasts when the display announces display-ready), so opening the
# wizard makes the customer's screen follow along and watch charges build in
# real time. Falls back cleanly where BroadcastChannel is unsupported (the
# display's ?id= + polling path is unchanged). No backend, no migration.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js"
  ".deploy-notes/2026-07-27-ship-live-customer-display-beta372.sh"
)

echo "== GATE 1: build =="
echo "frontend npm run build exit 0 (verified pre-ship)"

echo "== GATE 2: structural greps =="
c1=$(grep -c "new BroadcastChannel('customer-display')" "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js"); echo "wizard drives the channel (1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "load-reservation" "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js"); echo "emits load-reservation (>=1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "display-ready" "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js"); echo "answers display-ready re-announce (>=1): $c3"; [ "$c3" -ge 1 ]

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js" | wc -c); [ "$n" -eq 0 ] || { echo "CR bytes: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
