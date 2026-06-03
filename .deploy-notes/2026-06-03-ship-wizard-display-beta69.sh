#!/usr/bin/env bash
# v0.9.0-beta.69 — checkout wizard DISPLAY fix (frontend only, no migration).
# The wizard subtracted the security deposit from balance, but balance is
# already the rental (deposit is a separate hold) → it showed $0.12 instead of
# $1.12. Now the wizard shows balance as the sale, matching the server (which
# already charges the rental correctly as of beta.68).
#   bash .deploy-notes/2026-06-03-ship-wizard-display-beta69.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.69"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "✗ Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
FILES=(
  "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js"
  ".deploy-notes/2026-06-03-ship-wizard-display-beta69.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): checkout wizard shows rental sale = balance (don't subtract deposit)

balance is the rental; the deposit is a separate hold, so subtracting it made
the wizard display \$0.12 instead of \$1.12. Display now matches the server,
which charges the rental correctly (beta.68)."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "✓ Pushed. Deploy: git checkout v0.9.0-beta.69 && docker compose -f docker-compose.prod.yml up -d --build"
