#!/usr/bin/env bash
# =====================================================================
# Ship Dejavoo checkout fixes as v0.9.0-beta.67. Backend-only, NO migration.
# Run from your Mac, repo root:
#     bash .deploy-notes/2026-06-03-ship-dejavoo-fixes-beta67.sh
#
# Fixes from the live terminal test:
#  BUG 1 (amount split): runSale now charges the sale = agreement balance MINUS
#    the security deposit (resolved server-side from the SECURITY_DEPOSIT charge),
#    instead of trusting the wizard's amount. So RES-070080 charges $1.12 sale,
#    not $2.12. The $1.00 deposit stays a separate pre-auth hold.
#  BUG 3 (status didn't advance): the CLOSED transition now advances the
#    reservation to CHECKED_OUT, finalizes the agreement, syncs the vehicle to
#    ON_RENT, and writes an audit row.
#
#  BUG 2 (iPOS "API Key is required") is NOT code — it's a credential. The iPOS
#  Transact keys live in backend/.env on the droplet (env_file). Verify/set:
#     grep -E 'IPOS_TRANSACT_(API_KEY|SECRET_KEY|AUTH_TOKEN)' ~/RideFleetManagement/backend/.env
#  and paste the real values from the iPOSpays merchant portal, then rebuild.
# =====================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.67"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "✗ Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/checkout-session/spin-charge.service.js"
  "backend/src/modules/checkout-session/checkout-session.service.js"
  ".deploy-notes/2026-06-03-ship-dejavoo-fixes-beta67.sh"
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "✗ Missing $f" >&2; exit 1; }; done

echo "→ syntax check..."
( cd backend && node --check src/modules/checkout-session/spin-charge.service.js \
   && node --check src/modules/checkout-session/checkout-session.service.js ) \
   || { echo "✗ syntax check failed" >&2; exit 1; }
echo "  ✓ ok"

git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }

git commit -m "fix(dejavoo): server-side sale=balance-deposit + advance reservation to CHECKED_OUT on finalize

- spin-charge runSale: charge the rental (balance - security deposit) resolved
  from the agreement, not the wizard-sent amount. Stops the deposit being
  charged into the sale (RES-070080 was \$2.12 instead of \$1.12).
- checkout-session: on CLOSED, set Reservation.status=CHECKED_OUT, agreement
  FINALIZED, sync Vehicle->ON_RENT, audit. (Session reached CLOSED but the
  reservation stayed CONFIRMED.)
- iPOS 'API Key is required' is a backend/.env credential, not code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "✓ Pushed $BRANCH and $TAG."
cat <<'EOF'

Deploy (droplet, NO migration):
  cd ~/RideFleetManagement
  # 1. (BUG 2) verify/fix the iPOS key, then save the file:
  grep -E 'IPOS_TRANSACT_(API_KEY|SECRET_KEY|AUTH_TOKEN)' backend/.env
  #    -> if blank/placeholder, set the real iPOSpays portal values.
  # 2. deploy:
  git fetch --tags --force
  git checkout v0.9.0-beta.67
  docker compose -f docker-compose.prod.yml up -d --build
  sleep 60 && docker compose -f docker-compose.prod.yml ps

Re-test a checkout: sale should charge the RENTAL only (e.g. $1.12), the deposit
hold should approve (once the iPOS key is valid), and the reservation should flip
to CHECKED_OUT with the vehicle ON_RENT.
EOF
