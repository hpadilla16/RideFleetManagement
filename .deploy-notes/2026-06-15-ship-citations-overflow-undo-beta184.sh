#!/usr/bin/env bash
# v0.9.0-beta.184 — Citations UX: overflow fix + Undo + cola de Incoming documents
#   bash .deploy-notes/2026-06-15-ship-citations-overflow-undo-beta184.sh
#
# BACKEND + FRONTEND, code-only, sin migración. NO money.
#
# QUE ENTRA:
#   FIX overflow: la tabla de /citations se salía de su card → ahora en div
#     overflow-x:auto (scroll horizontal), table min-width 920.
#   Undo: botón para deshacer un Confirm/Dispute/Void accidental (lista + detalle)
#     → regresa la multa a NEEDS_REVIEW (decision REJECT, ya existía en backend).
#   Incoming documents (parte de la mejora #3): botón "Incoming docs" en /citations
#     abre una cola con los avisos subidos y su estado de OCR (PENDING/EXTRACTING/
#     INGESTED/REVIEW/FAILED), con "View scan" y "Retry" para los FAILED/REVIEW.
#     Backend: citations.service.retryDocument (resetea FAILED/REVIEW → PENDING) +
#     POST /api/citations/documents/:id/retry.
#
# Deploy: build backend + worker + FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   backend/src/modules/citations/citations.service.js
#   backend/src/modules/citations/citations.routes.js
#   frontend/src/app/citations/page.js
#   frontend/src/app/citations/[id]/page.js
#   .deploy-notes/2026-06-15-ship-citations-overflow-undo-beta184.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.184"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/citations/citations.routes.js"
  "frontend/src/app/citations/page.js"
  "frontend/src/app/citations/[id]/page.js"
  ".deploy-notes/2026-06-15-ship-citations-overflow-undo-beta184.sh"
)

# ── GATES
node --check backend/src/modules/citations/citations.service.js
node --check backend/src/modules/citations/citations.routes.js
grep -nq "async retryDocument" backend/src/modules/citations/citations.service.js || { echo "ABORT: retryDocument falta." >&2; exit 1; }
grep -nq "documents/:id/retry" backend/src/modules/citations/citations.routes.js || { echo "ABORT: ruta retry falta." >&2; exit 1; }
grep -nq "overflowX: 'auto'" frontend/src/app/citations/page.js || { echo "ABORT: wrap overflow falta." >&2; exit 1; }
grep -nq "review(r, 'REJECT')" frontend/src/app/citations/page.js || { echo "ABORT: Undo lista falta." >&2; exit 1; }
grep -nq "review('REJECT')" "frontend/src/app/citations/[id]/page.js" || { echo "ABORT: Undo detalle falta." >&2; exit 1; }
grep -nq "Incoming docs" frontend/src/app/citations/page.js || { echo "ABORT: panel Incoming docs falta." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): overflow fix + Undo review + Incoming documents queue/retry

Wrap the citations table in overflow-x:auto (the new columns overflowed the card).
Add an Undo action (list + detail) to revert an accidental Confirm/Dispute/Void back
to NEEDS_REVIEW. Add an Incoming-documents panel showing uploaded notice scans + OCR
status, with View-scan and Retry (resets FAILED/REVIEW docs to PENDING). Code-only."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh /citations."
