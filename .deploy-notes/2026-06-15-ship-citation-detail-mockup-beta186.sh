#!/usr/bin/env bash
# v0.9.0-beta.186 — Citation detail page: rediseño al estilo del mockup aprobado
#   bash .deploy-notes/2026-06-15-ship-citation-detail-mockup-beta186.sh
#
# FRONTEND-ONLY, sin migración. Mockup: doc/citations-detail-mockup-2026-06-15.html (VIEW B).
#
# La página de detalle (/citations/[id]) se reescribió para verse EXACTO como el
# mockup: grid de 2 columnas, panels, key-facts en grid 2-col, botón verde "Pay now",
# "View scanned notice", cards de vehículo y reserva, timeline de actividad, y review
# con notas + Confirm/Dispute/Void + Undo. CSS del mockup embebido (scoped .cd-root),
# conectado a la data real (GET /api/citations/:id + /:id/document).
#
# Deploy: build FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   frontend/src/app/citations/[id]/page.js
#   .deploy-notes/2026-06-15-ship-citation-detail-mockup-beta186.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.186"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/citations/[id]/page.js"
  ".deploy-notes/2026-06-15-ship-citation-detail-mockup-beta186.sh"
)

# ── GATES
grep -nq "cd-grid" "frontend/src/app/citations/[id]/page.js" || { echo "ABORT: layout del mockup falta." >&2; exit 1; }
grep -nq "Pay now" "frontend/src/app/citations/[id]/page.js" || { echo "ABORT: Pay now falta." >&2; exit 1; }
grep -nq "review('REJECT')" "frontend/src/app/citations/[id]/page.js" || { echo "ABORT: Undo falta." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): redesign citation detail page to match approved mockup

Rebuild /citations/[id] to match doc/citations-detail-mockup-2026-06-15.html (VIEW B):
two-column grid, panels, key-facts grid, green Pay-now button, View-scan, vehicle +
reservation cards, activity timeline, review (notes + Confirm/Dispute/Void + Undo).
Scoped mockup CSS, wired to live data. Frontend-only."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build frontend, force-recreate, HARD REFRESH a citation detail."
