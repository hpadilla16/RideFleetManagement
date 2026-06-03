#!/usr/bin/env bash
# v0.9.0-beta.101 — wizard amount display, robust fix. No migration.
#   bash .deploy-notes/2026-06-03-ship-wizard-charge-split-beta101.sh
#
# `balance` is inconsistent (sometimes includes the deposit, sometimes not), so
# neither subtracting nor not-subtracting the deposit worked for all reservations.
# Fix: getById now returns ALL selected agreement charges with their `source`, and
# the wizard computes the SALE = sum(non-deposit charges) − paid and the deposit =
# sum(SECURITY_DEPOSIT charges) — exactly what the server already charges.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.101"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/reservations/reservations.service.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/reservations/reservations.service.js"
  "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js"
  ".deploy-notes/2026-06-03-ship-wizard-charge-split-beta101.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): wizard computes sale from non-deposit charges (balance is unreliable)

getById returns all selected agreement charges with source; the wizard now shows
sale = sum(non-deposit charges) - paid and deposit = sum(SECURITY_DEPOSIT charges),
matching the server. Fixes the display reading \$2.12 or \$0.12 depending on
whether balance happened to include the deposit."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy: git checkout v0.9.0-beta.101 && docker compose -f docker-compose.prod.yml up -d --build"
