#!/usr/bin/env bash
# v0.9.0-beta.102 — getById returns ALL agreement charges (backend only, no migration).
#   bash .deploy-notes/2026-06-03-ship-getbyid-charges-beta102.sh
#
# ROOT CAUSE of the wizard showing "pre-paid" / wrong amounts: getById (the
# endpoint the wizard calls) restricted rentalAgreement.charges to SECURITY_DEPOSIT
# only. The beta.101 wizard computes sale = sum(non-deposit charges), so it saw
# zero rental → "pre-paid $0.00". Fix: getById now returns ALL selected charges
# (with source). Wizard then correctly shows sale $1.12 + deposit $1.00.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.102"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/reservations/reservations.service.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/reservations/reservations.service.js"
  ".deploy-notes/2026-06-03-ship-getbyid-charges-beta102.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): getById returns all agreement charges so the wizard can split sale vs deposit

getById restricted rentalAgreement.charges to SECURITY_DEPOSIT only; the beta.101
wizard computes sale = sum(non-deposit charges), so it saw \$0 rental and showed
pre-paid. Now returns all selected charges (with source). Sale \$1.12, deposit \$1.00."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy: git checkout v0.9.0-beta.102 && docker compose -f docker-compose.prod.yml up -d --build"
