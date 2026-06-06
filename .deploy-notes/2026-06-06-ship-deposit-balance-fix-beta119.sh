#!/usr/bin/env bash
# v0.9.0-beta.119 — deposit / AUTH_HOLD balance fix + check-in payment visibility.
#   bash .deploy-notes/2026-06-06-ship-deposit-balance-fix-beta119.sh
#
# ⚠️  MONEY PATH. Review `git diff --cached` before answering 'y'. No migrations.
#
# WHAT THIS SHIPS (5 files, all reviewed with Hector 2026-06-06):
#   1) Deposit charges (chargeType=DEPOSIT: Deposit Due + Security Deposit) are
#      EXCLUDED from agreement subtotal/total/balance across ALL builders
#      (structuredReservationTotals, replaceCharges, the 2 inline startFrom-
#      Reservation paths, and reservation-pricing summarizeChargeTotals /
#      syncAgreementCharges). New helper isDepositCharge. Matches the reservation
#      page's "Unpaid Balance". (Root cause of 100+ inflated balances.)
#   2) Option B — AUTH_HOLD deposit authorizations no longer count as paid:
#      agreement.paidAmount = real captured money only (method != AUTH_HOLD),
#      balance = max(0, total - paid), never negative. New canonical helper
#      recomputeAgreementPaidAndBalance used by maybeCreateAgreementPayment,
#      syncAgreementCharges, addManualPayment, importStructured, checkin-close,
#      captureCustomerCardOnFile and postRefund. (Did NOT touch the gateway
#      charge/refund calls themselves — only the post-charge balance bookkeeping.)
#   3) Check-in manual charge now mirrors into ReservationPayment (linked via
#      rentalAgreementPaymentId) so it shows in the View Payments panel and the
#      reservation page paid total. (Was posting to the agreement ledger only.)
#   4) Printed agreement "Amount Paid" excludes AUTH_HOLD and "Amount Due" never
#      prints negative.
#   5) Frontend: franchise-imports tray horizontal-scroll clip (Promote column
#      was unreachable) — minWidth:0 on the table wrapper grid item.
#
# AFTER this deploys + verifies: run ops/backup.sh, then the data repair
# (scripts/repair-deposit-balances.mjs, dry-run then --apply) for the 98
# already-inflated agreements. Zero RES-748258's $9,925 late fee separately.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
# Ship from the CURRENT branch (isolated 119 branch cut from v0.9.0-beta.117).
# Deploy is tag-based (droplet checks out the tag), so the branch name is just
# where the commit history lives.
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.119"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout a branch first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

# Explicit file list — NEVER `git add -A`. Leaves any other uncommitted work
# (e.g. the beta.118 Expedia scrape) untouched.
FILES=(
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/rental-agreements/checkin-close.service.js"
  "backend/src/modules/reservations/reservation-extend.service.js"
  "frontend/src/components/reservations/PendingFranchiseImportsTray.jsx"
  "scripts/repair-deposit-balances.mjs"
  ".deploy-notes/2026-06-06-ship-deposit-balance-fix-beta119.sh"
)

# ── SYNTAX GATE on the edited backend modules (same gate the other ship scripts use)
for f in \
  "backend/src/modules/reservations/reservation-pricing.service.js" \
  "backend/src/modules/rental-agreements/rental-agreements.service.js" \
  "backend/src/modules/rental-agreements/checkin-close.service.js" \
  "backend/src/modules/reservations/reservation-extend.service.js" ; do
  ( cd backend && node --check "${f#backend/}" )
done
echo "node --check OK on all edited backend files."

# ── ENV: this bundle adds NO new env keys, but keep the convention.
bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "⚠️  MONEY PATH — review the staged diff now:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(money): exclude deposits + AUTH_HOLD from agreement balance; mirror check-in payments to View Payments

Deposit charges (Deposit Due + Security Deposit, chargeType=DEPOSIT) were
leaking into agreement subtotal/total/balance in several builders, and
AUTH_HOLD deposit authorizations were counted as paidAmount. Result: 100+
agreements showed an inflated outstanding balance (deposit shown as owed) that
check-in / autocharge would have charged once the POS goes live.

- isDepositCharge(): exclude ALL deposit charges from total everywhere.
- Option B: paidAmount = real (non-AUTH_HOLD) payments; balance = max(0, total
  - paid). New recomputeAgreementPaidAndBalance() used after every payment
  mutation (incl. captureCustomerCardOnFile / postRefund bookkeeping; gateway
  charge calls untouched).
- Check-in manual charge now mirrors into ReservationPayment (linked) so it
  appears in View Payments and the reservation paid total.
- Printed agreement: Amount Paid excludes holds; Amount Due never negative.
- Frontend: franchise-imports tray horizontal scroll (Promote column reachable).

No migrations. Data repair for existing agreements runs separately
(scripts/repair-deposit-balances.mjs, dry-run then --apply)."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "POST-DEPLOY VERIFY (a green push is NOT a green deploy):"
echo "  • 4 containers healthy: fleet-db-prod fleet-backend-prod fleet-worker-prod fleet-frontend-prod"
echo "  • backend boots clean (no MODULE_NOT_FOUND / TypeError), /health 200"
echo "  • frontend hard-refresh (Cmd-Shift-R) — tray scroll + View Payments"
echo "  • smoke: do a manual charge at check-in → confirm it shows in View Payments"
echo
echo "THEN (data): bash ops/backup.sh  →  run scripts/repair-deposit-balances.mjs (dry-run, then --apply)."
