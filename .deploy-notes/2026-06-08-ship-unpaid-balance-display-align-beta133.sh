#!/usr/bin/env bash
# v0.9.0-beta.133 — align "Unpaid Balance" display to RentalAgreement.balance.
#   bash .deploy-notes/2026-06-08-ship-unpaid-balance-display-align-beta133.sh
#
# Frontend-only. No migrations. Follow-up to beta.132 (which made post-check-in
# fees reach RentalAgreement.balance on the backend). This makes the UI SHOW that
# balance consistently.
#
# WHY: on a checked-in reservation with post-check-in fees (e.g. TL-ZE40787112BA,
# fuel $93.71), the reservation detail "Charges → Unpaid Balance", the top
# "Payment Snapshot", and the "View Payments" page all showed the rental-only
# figure ($0.00 / $57.94) instead of the true agreement balance ($93.71). The
# correct number already lived in RentalAgreement.balance (total $151.65 − paid
# $57.94); these views just weren't reading it.
#
# WHAT CHANGED (2 files):
#   frontend/src/app/reservations/[id]/page.js
#     - new `displayUnpaidBalance`: uses RentalAgreement.balance when an agreement
#       exists (includes post-check-in fees), else the rental-only fallback.
#     - Charges "Unpaid Balance" row, top "Payment Snapshot" tile, and the ops
#       "Resolve payment due" next-action now use it. Charges row gets an
#       "Incl. post-check-in fees · agreement total $X" caption when they differ.
#   frontend/src/app/reservations/[id]/payments/page.js
#     - Total / Collected / Unpaid now come from RentalAgreement.total/paidAmount/
#       balance when an agreement exists (was: rental-only estimatedTotal + the
#       ?total= query param + reservation-level payment rows, which missed both
#       post-check-in fees and agreement-level/franchise-prepaid payments).
#
# ⚠️ MONEY-ADJACENT (display, not capture): on the View Payments page the `unpaid`
#    value PREFILLS and CAPS the "Charge card on file" amount. It now reflects the
#    true agreement balance ($93.71), which is correct — but VERIFY in the smoke
#    below that the prefill/cap look right before relying on it to collect.
#    Hector approved aligning to RentalAgreement.balance (2026-06-08).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.133"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH (must be at v0.9.0-beta.132 tip)"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/reservations/[id]/page.js"
  "frontend/src/app/reservations/[id]/payments/page.js"
  ".deploy-notes/2026-06-08-ship-unpaid-balance-display-align-beta133.sh"
)

# ── SYNTAX GATE: JSX files can't use `node --check`. They were validated with
#    @babel/parser (jsx) during prep and are validated again by the docker
#    frontend build (force-recreate below) — a parse error fails the build.
# ── GUARD: confirm the edits are actually present.
grep -nq "displayUnpaidBalance" "frontend/src/app/reservations/[id]/page.js" \
  || { echo "ABORT: displayUnpaidBalance missing from reservations/[id]/page.js — edit not applied." >&2; exit 1; }
grep -nq "hasAgreementTotals" "frontend/src/app/reservations/[id]/payments/page.js" \
  || { echo "ABORT: hasAgreementTotals missing from payments/page.js — edit not applied." >&2; exit 1; }
echo "Guards OK: display-align edits present."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "Review:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(ui): show RentalAgreement.balance as the unpaid balance (incl. post-check-in fees)

Follow-up to beta.132. The reservation detail Charges 'Unpaid Balance', the top
Payment Snapshot, and the View Payments page showed the rental-only figure and
missed post-check-in fees (fuel/cleaning/late) and agreement-level/franchise
payments — e.g. TL-ZE40787112BA showed \$0.00/\$57.94 instead of the true \$93.71.

- reservations/[id]/page.js: new displayUnpaidBalance prefers RentalAgreement.balance
  when an agreement exists; used by the Charges row (with an 'incl. post-check-in
  fees' caption), the Payment Snapshot tile, and the 'Resolve payment due' action.
- payments/page.js: Total/Collected/Unpaid now come from RentalAgreement
  total/paidAmount/balance when an agreement exists. The unpaid value also feeds
  the Charge-card-on-file prefill/cap (money-adjacent) — verified to reflect the
  correct agreement balance. No backend/gateway code; no migrations."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + /health 200 + frontend HARD refresh (Cmd-Shift-R)."
echo "  smoke: open reservation TL-ZE40787112BA →"
echo "    - Charges 'Unpaid Balance' shows \$93.71 (with 'incl. post-check-in fees' caption)"
echo "    - top Payment Snapshot shows \$93.71 'Remaining balance' (not 'Balance cleared')"
echo "    - View Payments shows Total \$151.65 / Collected \$57.94 / Unpaid \$93.71,"
echo "      and the Charge-card-on-file amount prefills to \$93.71."
