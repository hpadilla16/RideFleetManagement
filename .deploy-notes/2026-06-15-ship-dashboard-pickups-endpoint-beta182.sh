#!/usr/bin/env bash
# v0.9.0-beta.182 — Dashboard pickups/returns: pegar al endpoint correcto
#   bash .deploy-notes/2026-06-15-ship-dashboard-pickups-endpoint-beta182.sh
#   (181 ya pertenece a otro deploy; este sube a 182.)
#
# FRONTEND-ONLY, sin migración. Hotfix del fix de pickups-today.
#
# BUG: el dashboard llamaba /api/reservations?filter=pickups-today, pero ESE
# endpoint (list) ignora ?filter (solo usa page+limit) → devolvía 500 sin filtrar
# (el board mostró "500 pickups / 500 returns"). El que respeta ?filter es
# /api/reservations/page (listPage), donde el filtro pickups-today/returns-today
# ya vive. Fix: apuntar los dos fetches a /api/reservations/page.
#
# Deploy: build FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   frontend/src/app/page.js
#   .deploy-notes/2026-06-15-ship-dashboard-pickups-endpoint-beta182.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.182"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/page.js"
  ".deploy-notes/2026-06-15-ship-dashboard-pickups-endpoint-beta182.sh"
)

# ── GATES
grep -nq "api('/api/reservations/page?filter=pickups-today" frontend/src/app/page.js || { echo "ABORT: fetch no apunta a /page." >&2; exit 1; }
! grep -nq "api('/api/reservations?filter=pickups-today" frontend/src/app/page.js || { echo "ABORT: todavía existe el fetch al endpoint viejo." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(dashboard): use /api/reservations/page for pickups/returns-today filters

The dashboard fetched /api/reservations?filter=pickups-today, but that list endpoint
ignores ?filter (only page+limit), returning an unfiltered 500. The /page endpoint
(listPage) honors the filter where pickups-today/returns-today live. Point both
fetches there so the board shows the real today count/list."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build frontend, force-recreate, HARD REFRESH dashboard."
