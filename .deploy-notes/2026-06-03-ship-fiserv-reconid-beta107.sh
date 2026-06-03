#!/usr/bin/env bash
# v0.9.0-beta.107 — send reconId on tokenized Sale/PreAuth (Fiserv requirement).
#   bash .deploy-notes/2026-06-03-ship-fiserv-reconid-beta107.sh
#
# Hector's TPN processes through FISERV. Per the iPOSpays docs, reconId is
# MANDATORY on Fiserv processors — we never sent it, which is the leading
# explanation for the processor host's 904 FORMAT ERROR (gateway validation
# passes, token resolves to the card, host rejects the message).
#
# Docs contradict on length (field table: Fiserv North = 11; sample comment:
# 10), so length is env-tunable WITHOUT redeploy:
#   IPOS_TRANSACT_RECON_ID_LEN=11   (default; try 10 if 904 persists, 0 = off)
# Value is merchant-generated uppercase alphanumeric, exact length.
#
# Ruled out already (live tests): NetGrossIndicator string (fixed beta.105),
# L3 block entirely (env-off, same error), hyphenated reference IDs +
# iposhpresponse parsing (fixed beta.106).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.107"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/payment-gateway/ipos-transact-client.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/payment-gateway/ipos-transact-client.js"
  ".deploy-notes/2026-06-03-ship-fiserv-reconid-beta107.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "feat(dejavoo): send reconId on tokenized Sale/PreAuth (mandatory on Fiserv)

TPN processes through Fiserv; iPOSpays docs mark reconId mandatory there.
Missing reconId is the leading cause of the host 904 FORMAT ERROR. Length is
env-tunable (IPOS_TRANSACT_RECON_ID_LEN, default 11; docs contradict 10 vs 11;
0 disables). Merchant-generated uppercase alphanumeric, exact length."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy (backend only):"
echo "  git checkout v0.9.0-beta.107 && docker compose -f docker-compose.prod.yml build backend worker && docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps backend worker"
echo "If 904 persists: edit backend/.env IPOS_TRANSACT_RECON_ID_LEN=10 and force-recreate backend (no rebuild)."
