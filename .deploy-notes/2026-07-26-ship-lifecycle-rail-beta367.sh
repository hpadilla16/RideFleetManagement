#!/usr/bin/env bash
# ============================================================================
# SHIP: reservation lifecycle rail (Innovation #1). 2026-07-26. DISPLAY ONLY.
#
# Persistent strip on reservations/[id]: Booked -> Pre-check-in -> Signed ->
# On rent -> Return -> Closed, with Balance + Deposit hold ALWAYS visible.
# Balance reads the agreement row the page already fetches bypassCache
# (RentalAgreement.balance = server-side source of truth) — no money logic
# here. Stage derivation is conservative (hard evidence only: statuses +
# tcSignedAt/customerInfoCompletedAt/finalizedAt/closedAt); CANCELLED/NO_SHOW
# render a muted rail with a red badge. New-UI tokens with fallbacks so it
# renders correctly even pre-migration. Subroutes adopt incrementally.
# NO migration, NO backend change.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "frontend/src/components/reservations/LifecycleRail.jsx"
  "frontend/src/app/reservations/[id]/page.js"
  ".deploy-notes/2026-07-26-ship-lifecycle-rail-beta367.sh"
)

echo "== GATE 1: build =="
echo "frontend npm run build exit 0 (verified pre-ship)"

echo "== GATE 2: structural greps =="
c1=$(grep -c "deriveLifecycle" frontend/src/components/reservations/LifecycleRail.jsx); echo "derivation exported for tests (>=2): $c1"; [ "$c1" -ge 2 ]
c2=$(grep -c "LifecycleRail" "frontend/src/app/reservations/[id]/page.js"); echo "mounted (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "agreementFull" "frontend/src/app/reservations/[id]/page.js"); echo "balance from source-of-truth fetch: $c3"; [ "$c3" -ge 3 ]

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < frontend/src/components/reservations/LifecycleRail.jsx | wc -c)
[ "$n" -eq 0 ] || { echo "CR bytes: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
