#!/usr/bin/env bash
# v0.9.0-beta.103 — iPOS auth-token: send credentials as HTTP HEADERS (backend only, no migration).
#   bash .deploy-notes/2026-06-03-ship-ipos-auth-headers-beta103.sh
#
# ROOT CAUSE of "Deposit hold declined: API Key is required." (AUTH_ERR_001):
# the iPOSpays Authentication Token API reads apiKey/secretKey/scope/
# jwtTokenExpiryMinutes from HTTP HEADERS (docs label it "Sample Header
# Request"). callAuthApi was sending them only in the JSON body, so iPOSpays
# saw no apiKey and returned AUTH_ERR_001 — even though the env value is clean
# (verified: KEY=[dakey_...], SCOPE=[PaymentTokenization], secret present).
# Fix: callAuthApi now sends each field as a header (string) AND keeps it in
# the body, so generate + refresh both authenticate. Unblocks the deposit hold
# and all card-on-file Transact charges.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.103"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/payment-gateway/ipos-auth.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/payment-gateway/ipos-auth.js"
  ".deploy-notes/2026-06-03-ship-ipos-auth-headers-beta103.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): iPOS auth-token sends credentials as HTTP headers (fixes AUTH_ERR_001)

The iPOSpays Authentication Token API reads apiKey/secretKey/scope/
jwtTokenExpiryMinutes from HTTP headers, not the JSON body (docs: 'Sample
Header Request'). callAuthApi sent them only in the body, so the API returned
AUTH_ERR_001 'API Key is required' and the deposit hold failed. Now sends each
field as a header and keeps the body too. Unblocks deposit hold + card-on-file."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy: git checkout v0.9.0-beta.103 && docker compose -f docker-compose.prod.yml up -d --build"
