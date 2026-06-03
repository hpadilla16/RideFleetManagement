#!/usr/bin/env bash
# v0.9.0-beta.110 — AUTH_HOLD rows don't count as paid (backend only).
#   bash .deploy-notes/2026-06-03-ship-authhold-excluded-beta110.sh
#
# beta.109's recompute summed ALL status=PAID payment rows. Manual deposit
# holds are recorded as method=AUTH_HOLD with status=PAID, so a $1.00 hold
# counted as money received → agreement showed paid $2.12 on a $1.12 rental.
# Canonical rule now: deposit never in balance, hold never in paid.
# Repair SQL (doc/fixes/2026-06-03-agreement-ledger-repair.sql) updated the
# same way — RE-RUN it after this deploy (preview → apply).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.110"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/checkout-session/spin-charge.service.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/checkout-session/spin-charge.service.js"
  "doc/fixes/2026-06-03-agreement-ledger-repair.sql"
  ".deploy-notes/2026-06-03-ship-authhold-excluded-beta110.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): exclude AUTH_HOLD rows from paidAmount recompute

Manual deposit holds are AUTH_HOLD rows with status PAID; counting them made
paidAmount 2.12 on a 1.12 rental. Canonical money model: deposit never in
balance, hold never in paid. Repair SQL updated to match (re-run it)."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy (backend only):"
echo "  git checkout v0.9.0-beta.110 && docker compose -f docker-compose.prod.yml build backend worker && docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps backend worker"
echo "Then RE-RUN doc/fixes/2026-06-03-agreement-ledger-repair.sql (preview, then apply)."
