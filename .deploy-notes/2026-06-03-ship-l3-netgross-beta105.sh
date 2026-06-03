#!/usr/bin/env bash
# v0.9.0-beta.105 — NetGrossIndicator: boolean false, not string 'N' (backend only, no migration).
#   bash .deploy-notes/2026-06-03-ship-l3-netgross-beta105.sh
#
# Dejavoo support flagged our string 'N' as "not a valid attribute". Their field
# table documents String N/Y, but their sample payload (and apparently their
# validator) uses BOOLEAN: "NetGrossIndicator": false. Per their instruction we
# now send boolean false. Their L3 validation hard-fails transactions (l2l3Flag
# "E"), so the string form may have contributed to DEJ_ERR_003. If boolean still
# fails, next step is removing the field entirely (it's optional).
#
# NOTE: this becomes the new Dejavoo redeploy tag (supersedes beta.104 in the
# handoff). Prod stays on beta.65 until the Dejavoo CNP go-ahead; then:
#   git checkout v0.9.0-beta.105 && docker compose -f docker-compose.prod.yml up -d --build
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.105"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/payment-gateway/ipos-transact-client.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/payment-gateway/ipos-transact-client.js"
  ".deploy-notes/2026-06-03-ship-l3-netgross-beta105.sh"
  "doc/session-handoff-2026-06-03.md"
  "doc/checkout-checkin-pos-playbook-2026-06-03.html"
  "doc/fixes/2026-06-03-forecast-accuracy-audit.sql"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): NetGrossIndicator as boolean false, not string 'N' (per Dejavoo support)

Dejavoo's validator rejects the string form ('N') documented in their field
table; their sample payload uses boolean false and support instructed us to
send that. Their L3 validation hard-fails transactions (l2l3Flag E), so the
string form may have contributed to DEJ_ERR_003 on tokenized PreAuth/Sale.
If boolean still fails, next step is removing the field (it's optional)."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Dejavoo redeploy tag is now $TAG (was beta.104)."
