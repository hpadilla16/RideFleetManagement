#!/usr/bin/env bash
# v0.9.0-beta.109 — agreement ledger recompute after wizard payments
# (backend only, no migration; + one-time SQL repair for today's agreements).
#   bash .deploy-notes/2026-06-03-ship-ledger-recompute-beta109.sh
#
# BUG: the checkout wizard recorded RentalAgreementPayment rows (terminal sale,
# manual bypass) but never updated RentalAgreement.paidAmount/balance — the
# agreement page showed balance $1.12 after the $1.12 sale was recorded. The
# void-rollback comment referenced a "paidAmount recompute" that didn't exist.
#
# FIX: recomputeAgreementPaid() — paidAmount = Σ ledger rows (status PAID,
# voids drop out); balance = max(0, Σ selected non-deposit charges − paid).
# Balance excludes SECURITY_DEPOSIT (a hold, not money owed) — same formula
# the wizard + runSale already use. Called after: terminal sale (runSale),
# combined charge sequence, manual payment, and sale void rollback.
#
# AFTER DEPLOY: run doc/fixes/2026-06-03-agreement-ledger-repair.sql in
# Supabase (preview, then apply) to fix agreements created today.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.109"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/checkout-session/spin-charge.service.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/checkout-session/spin-charge.service.js"
  "doc/fixes/2026-06-03-agreement-ledger-repair.sql"
  ".deploy-notes/2026-06-03-ship-ledger-recompute-beta109.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): recompute agreement paidAmount/balance after wizard payments

Wizard payment paths created ledger rows but never updated the agreement, so
balance stayed at the pre-payment value. New recomputeAgreementPaid(): paid =
sum of PAID payment rows; balance = max(0, non-deposit charges - paid), i.e.
the deposit hold is not money owed. Wired into runSale, runChargeSequence,
recordManualPayment, and the sale-void rollback. One-time repair SQL included
for agreements created 2026-06-03."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy (backend only):"
echo "  git checkout v0.9.0-beta.109 && docker compose -f docker-compose.prod.yml build backend worker && docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps backend worker"
echo "Then run doc/fixes/2026-06-03-agreement-ledger-repair.sql in Supabase (preview → apply)."
