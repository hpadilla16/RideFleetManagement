#!/usr/bin/env bash
# v0.9.0-beta.108 — wizard refetches reservation on entering payment step
# (frontend only, no migration).
#   bash .deploy-notes/2026-06-03-ship-wizard-step3-refetch-beta108.sh
#
# BUG: first pass through checkout, step 3 showed sale+deposit merged
# ($2.12 subtotal / $0 pre-auth); a manual browser refresh fixed it.
# CAUSE: the wizard fetches the reservation (incl. rentalAgreement.charges)
# once on mount, but the agreement charges are created/updated server-side
# during steps 1-2 — so step 3 read a stale copy with no charges and fell
# back to balance math. FIX: refetch the reservation (bypassCache) whenever
# the session enters PAYMENT_PENDING.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.108"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
FILES=(
  "frontend/src/app/reservations/[id]/checkout-wizard-v2/page.js"
  ".deploy-notes/2026-06-03-ship-wizard-step3-refetch-beta108.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): wizard refetches reservation entering payment step

Agreement charges are created during steps 1-2, so the mount-time reservation
copy is stale by step 3 — wizard showed sale+deposit merged (2.12/0) until a
manual refresh. Refetch (bypassCache) when the session enters PAYMENT_PENDING."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy (frontend only):"
echo "  git checkout v0.9.0-beta.108 && docker compose -f docker-compose.prod.yml build frontend && docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps frontend"
echo "Then hard-refresh the browser (Cmd+Shift+R)."
