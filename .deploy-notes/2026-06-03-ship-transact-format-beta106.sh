#!/usr/bin/env bash
# v0.9.0-beta.106 — Transact: alphanumeric transactionReferenceId + accept
# iposhpresponse response shape (backend only, no migration).
#   bash .deploy-notes/2026-06-03-ship-transact-format-beta106.sh
#
# Two fixes from the live FORMAT ERROR (errResponseCode 05 / host 904) debugging:
#   1. transactionReferenceId must be ALPHANUMERIC per spec; ours had hyphens
#      ("COF-RA-20260-pydwoo3") which the gateway echoes to the processor host
#      — prime suspect for host 904 FORMAT ERROR. shortRef now emits strictly
#      [A-Za-z0-9] (e.g. "COFRA20260603pye01b5").
#   2. The live API wraps responses in `iposhpresponse`, not the documented
#      `iposTransactResponse`. Success detection + normalizeResponse now accept
#      both — without this, even an APPROVED charge would parse as failed
#      (responseCode NaN) and risk an agent double-charging on retry.
# Confirmed earlier today: DEJ_ERR_003 fixed by NetGrossIndicator:false
# (beta.105); CNP channel reaches the processor (real RRN/batch); L3 ruled out
# via IPOS_TRANSACT_AUTO_RENTAL=false (FORMAT ERROR persisted without L3).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="release/v0.9.0-beta.58"; TAG="v0.9.0-beta.106"
[ "$(git branch --show-current)" = "$BRANCH" ] || { echo "Not on $BRANCH" >&2; exit 1; }
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true
( cd backend && node --check src/modules/payment-gateway/ipos-transact-client.js ) || { echo "syntax fail" >&2; exit 1; }
FILES=(
  "backend/src/modules/payment-gateway/ipos-transact-client.js"
  ".deploy-notes/2026-06-03-ship-transact-format-beta106.sh"
)
git add -- "${FILES[@]}"; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged."; exit 0; }
git commit -m "fix(dejavoo): alphanumeric Transact reference IDs + accept iposhpresponse shape

transactionReferenceId spec is alphanumeric; our hyphenated refs are the prime
suspect for the processor host 904 FORMAT ERROR. Also: the live API returns
iposhpresponse (docs show iposTransactResponse) — success detection and
normalizeResponse accept both, otherwise approved charges parse as failures."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo "Pushed. Deploy (backend only):"
echo "  git checkout v0.9.0-beta.106 && docker compose -f docker-compose.prod.yml build backend worker && docker compose -f docker-compose.prod.yml up -d --force-recreate --no-deps backend worker"
