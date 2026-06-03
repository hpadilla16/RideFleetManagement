#!/usr/bin/env bash
# v0.9.0-beta.104 — deposit hold falls back to card-present Auth when the
# Transact CNP channel isn't provisioned (backend only, no migration).
#   bash .deploy-notes/2026-06-03-ship-card-present-deposit-beta104.sh
#
# CONTEXT: auth-token (beta.103) is fixed and the token mints fine, but BOTH
# tokenized Transact ops fail identically with the generic DEJ_ERR_003:
#   • PreAuth (tt5) via hold-deposit
#   • Sale  (tt1) via charge-card-on-file
# Our request shape matches the iPOSpays docs (transactionType 1/5, cardToken,
# merchantAuthentication/transactionRequest/preferences), and SPIn is a
# documented-valid token source — so this is a MERCHANT-PROVISIONING gap: the
# Transact / card-on-file CNP channel isn't enabled on the TPN. Dejavoo must
# turn it on (morning call).
#
# TONIGHT'S UNBLOCK: IPOS_FORCE_CARD_PRESENT_DEPOSIT=true makes the deposit hold
# run as a card-present terminal Auth (a second tap) instead of CNP. The
# customer is at the counter at checkout, so this is the proven two-tap flow.
# The card token is still captured + stored for later. Flip the flag OFF once
# Dejavoo enables the CNP channel to restore the no-second-tap hold.
#
# AFTER DEPLOY, on the droplet add to backend/.env:
#   IPOS_FORCE_CARD_PRESENT_DEPOSIT=true
# then: docker compose -f docker-compose.prod.yml up -d   (restart picks up env)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.104"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/checkout-session/spin-charge.service.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/checkout-session/spin-charge.service.js"
  ".deploy-notes/2026-06-03-ship-card-present-deposit-beta104.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "feat(dejavoo): IPOS_FORCE_CARD_PRESENT_DEPOSIT flag for deposit hold

The Transact CNP channel isn't provisioned on the TPN yet, so tokenized PreAuth
(and Sale) return DEJ_ERR_003. Add a flag that routes the deposit hold to a
card-present terminal Auth (second tap) until Dejavoo enables CNP. Token is
still captured for later; flip the flag off to restore the no-second-tap hold."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy: git checkout v0.9.0-beta.104 && docker compose -f docker-compose.prod.yml up -d --build"
echo "Then add IPOS_FORCE_CARD_PRESENT_DEPOSIT=true to backend/.env and: docker compose -f docker-compose.prod.yml up -d"
