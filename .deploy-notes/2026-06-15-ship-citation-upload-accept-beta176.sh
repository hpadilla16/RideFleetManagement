#!/usr/bin/env bash
# v0.9.0-beta.176 — Citations "Upload notice": aceptar PDFs en el file picker
#   bash .deploy-notes/2026-06-15-ship-citation-upload-accept-beta176.sh
#
# FRONTEND-ONLY, sin migración. El input de upload usaba accept="application/pdf"
# (MIME) y el diálogo de macOS griseaba el PDF. Se agregan las EXTENSIONES
# explícitas (.pdf/.png/.jpg/.jpeg/.webp) para que el selector lo permita.
#
# Deploy: build frontend + force-recreate + HARD REFRESH.
#
# FILES:
#   frontend/src/app/citations/page.js
#   .deploy-notes/2026-06-15-ship-citation-upload-accept-beta176.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.176"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/citations/page.js"
  ".deploy-notes/2026-06-15-ship-citation-upload-accept-beta176.sh"
)

# ── GATES
grep -nq 'accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/\*"' frontend/src/app/citations/page.js || { echo "ABORT: accept con extensiones no está." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(citations): allow PDFs in Upload notice picker (add file extensions to accept)

macOS file dialog grayed out PDFs because accept used only the application/pdf MIME.
Add explicit extensions (.pdf/.png/.jpg/.jpeg/.webp) so the picker selects them."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build frontend, force-recreate, HARD REFRESH /citations."
