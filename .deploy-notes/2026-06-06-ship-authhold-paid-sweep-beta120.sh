#!/usr/bin/env bash
# v0.9.0-beta.120 — AUTH_HOLD-counted-as-paid sweep (follow-up to beta.119).
#   bash .deploy-notes/2026-06-06-ship-authhold-paid-sweep-beta120.sh
#
# ⚠️  MONEY-DISPLAY PATH. Review `git diff --cached` before 'y'. No migrations.
#
# beta.119 fixed the agreement balance / View-Payments mirror. This sweeps the
# REMAINING spots that still counted an AUTH_HOLD security-deposit authorization
# as settled "paid" money — which made a reservation that still owes money show
# "PAID IN FULL" / a too-low balance (surfaced on RES-042412). All fixes exclude
# AUTH_HOLD from the paid total; direction is always "show the true (higher)
# amount owed" — never undercharges. No gateway charge/refund calls touched.
#
#   1) reservations/[id]/payments/page.js  — the "Collected"/"Paid In Full"
#      snapshot summed AUTH_HOLD as collected.
#   2) customer-portal.routes.js (paidFromStructuredPayments) — customer PORTAL
#      balance + pay-link counted the hold as paid.
#   3) reservations/[id]/customer-view/page.js — customer-view balance.
#   4) customer-display/page.js — counter display: ALSO double-counted (it
#      concatenated reservation.payments + rentalAgreement.payments, so a
#      mirrored payment was summed twice) — now deduped by rentalAgreementPaymentId.
#   5) fees/fee-engine.service.js — posting a fee recomputed paidAmount incl. holds.
#   6) rental-agreements.service.js — agreement-creation prePaidTotal incl. holds.
#
# NOT in this bundle (flagged): checkout-wizard/page.js:574 (lives in the
# uncommitted Expedia WIP — apply there when you resume it) and
# reports/agent-track-record.report.js:204 (report metric — your semantics call).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.120"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout a branch first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/fees/fee-engine.service.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/customer-portal/customer-portal.routes.js"
  "frontend/src/app/reservations/[id]/payments/page.js"
  "frontend/src/app/reservations/[id]/customer-view/page.js"
  "frontend/src/app/customer-display/page.js"
  ".deploy-notes/2026-06-06-ship-authhold-paid-sweep-beta120.sh"
)

# ── SYNTAX GATE on edited backend modules
for f in \
  "backend/src/modules/fees/fee-engine.service.js" \
  "backend/src/modules/rental-agreements/rental-agreements.service.js" \
  "backend/src/modules/customer-portal/customer-portal.routes.js" ; do
  ( cd backend && node --check "${f#backend/}" )
done
echo "node --check OK on all edited backend files."

# ── ENV: no new env keys, but keep the convention.
bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "⚠️  MONEY-DISPLAY — review:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(money-display): exclude AUTH_HOLD from 'paid' everywhere it was counted as settled

Follow-up to beta.119. An AUTH_HOLD is a security-deposit authorization, not
captured funds, but several balance/collected computations still summed it as
paid — so a reservation that still owed money could show 'PAID IN FULL' or a
too-low balance (RES-042412). Excluded AUTH_HOLD from: the payments snapshot
('Collected'), the customer portal balance + pay-link, customer-view,
customer-display (also de-duplicated the two payment ledgers it was concatenating
+ double-counting), the fee-engine paidAmount recompute, and agreement-creation
prePaidTotal. Direction is always 'show the true amount owed'. No migrations; no
gateway charge/refund calls changed."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + /health 200 + frontend hard-refresh."
echo "  smoke: open RES-042412 Payments — should now show real Collected + the"
echo "         true unpaid balance (NOT 'PAID IN FULL')."
