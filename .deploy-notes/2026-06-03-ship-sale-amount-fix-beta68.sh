#!/usr/bin/env bash
# =====================================================================
# v0.9.0-beta.68 — correct the checkout sale amount. Backend-only, no migration.
# Run from your Mac, repo root:
#     bash .deploy-notes/2026-06-03-ship-sale-amount-fix-beta68.sh
#
# beta.67 computed sale = balance − deposit, but `balance` already excludes the
# deposit on some agreements (saw 1.12 − 1.00 = 0.12). beta.68 computes the sale
# directly from the charges: sum of SELECTED, NON-SECURITY_DEPOSIT charges minus
# paidAmount. RES-070080 → Daily $1.00 + Tax $0.12 = $1.12. Deposit stays a
# separate $1.00 hold.
# =====================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.68"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "✗ Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/checkout-session/spin-charge.service.js"
  ".deploy-notes/2026-06-03-ship-sale-amount-fix-beta68.sh"
)
( cd backend && node --check src/modules/checkout-session/spin-charge.service.js ) || { echo "✗ syntax" >&2; exit 1; }

git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): compute checkout sale from non-deposit charges, not balance

beta.67's sale = balance − deposit undercharged when balance already excluded
the deposit (1.12 − 1.00 = 0.12). Now sale = sum(selected non-SECURITY_DEPOSIT
charges) − paidAmount. RES-070080 → \$1.12. Deposit unchanged (separate hold)."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "✓ Pushed. Deploy: git checkout v0.9.0-beta.68 && docker compose -f docker-compose.prod.yml up -d --build"
