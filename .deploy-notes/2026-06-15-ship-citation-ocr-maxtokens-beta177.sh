#!/usr/bin/env bash
# v0.9.0-beta.177 — Citations OCR: subir max_tokens (fix JSON truncado)
#   bash .deploy-notes/2026-06-15-ship-citation-ocr-maxtokens-beta177.sh
#
# BACKEND/WORKER, code-only, sin migración. El primer OCR real falló con
# "Expected ',' or ']' ... JSON" porque max_tokens=1500 cortaba la respuesta del
# modelo a la mitad → JSON inválido. Fix: max_tokens=8000 + se le pide al modelo
# salida JSON compacta (sin pretty-print) para que no se corte.
#
# Tras deployar: re-subir el aviso en /citations (el doc anterior quedó FAILED; el
# worker solo reintenta los PENDING, así que un re-upload crea uno nuevo).
#
# Deploy: build backend + worker + force-recreate. Verificar 3 healthy + boot limpio.
#
# FILES:
#   backend/src/modules/citations/citation-ocr.extract.js
#   .deploy-notes/2026-06-15-ship-citation-ocr-maxtokens-beta177.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.177"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/citations/citation-ocr.extract.js"
  ".deploy-notes/2026-06-15-ship-citation-ocr-maxtokens-beta177.sh"
)

# ── GATES
node --check backend/src/modules/citations/citation-ocr.extract.js
grep -nq "max_tokens: 8000" backend/src/modules/citations/citation-ocr.extract.js || { echo "ABORT: max_tokens no es 8000." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(citations): bump OCR max_tokens 1500->8000 + compact JSON (fix truncated output)

First real OCR failed with a JSON parse error because max_tokens=1500 truncated the
model output mid-array. Raise to 8000 and instruct compact/minified JSON so multi-field
or multi-citation notices extract fully."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker, force-recreate, then RE-UPLOAD the notice in /citations."
