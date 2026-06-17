#!/usr/bin/env bash
# v0.9.0-beta.195 — Sidebar reorg: Inventory Reports → dentro de Reports, esconder Employee
#   App, quitar Agreement clauses (ya vive en Settings).
#   bash .deploy-notes/2026-06-16-ship-sidebar-reorg-beta195.sh
#
# FRONTEND-only, code-only, SIN migración. NO money.
#
# QUE ENTRA (AppShell NAV_ITEMS):
#   - Quitado el item "Inventory Reports" del sidebar → ahora aparece como TILE dentro de
#     /reports-v2 (categoría Fleet) que enlaza a /reports-v2/inventory-reports (no queda
#     huérfano). La ruta sigue funcionando.
#   - "Employee App" escondido (comentado) — no se usa ahora; /employee sigue vivo.
#   - "Agreement clauses" quitado del sidebar — ya está dentro de Settings.
#
# Deploy: build FRONTEND + force-recreate + HARD REFRESH (no backend, no migración).
#
# FILES:
#   frontend/src/components/AppShell.jsx
#   frontend/src/app/reports-v2/page.js
#   .deploy-notes/2026-06-16-ship-sidebar-reorg-beta195.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.195"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/components/AppShell.jsx"
  "frontend/src/app/reports-v2/page.js"
  ".deploy-notes/2026-06-16-ship-sidebar-reorg-beta195.sh"
)

# ── GATES — confirm the three items are no longer ACTIVE nav entries.
grep -Eq "^[[:space:]]*\{ href: '/reports-v2/inventory-reports'" frontend/src/components/AppShell.jsx && { echo "ABORT: Inventory Reports sigue en el nav." >&2; exit 1; } || true
grep -Eq "^[[:space:]]*\{ href: '/employee'" frontend/src/components/AppShell.jsx && { echo "ABORT: Employee App sigue activo en el nav." >&2; exit 1; } || true
grep -Eq "^[[:space:]]*\{ href: '/settings/agreement-clauses'" frontend/src/components/AppShell.jsx && { echo "ABORT: Agreement clauses sigue en el nav." >&2; exit 1; } || true
grep -q "slug: 'inventory-reports'" frontend/src/app/reports-v2/page.js || { echo "ABORT: tile de Inventory Reports falta en /reports-v2." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "chore(nav): sidebar reorg — Inventory Reports into Reports, hide Employee App, drop Agreement clauses

Removed the standalone 'Inventory Reports' nav item; it now shows as a Fleet tile on the
/reports-v2 landing (routes to /reports-v2/inventory-reports). Hid 'Employee App' (not in use;
route still works). Removed 'Agreement clauses' from the sidebar — it already lives inside
Settings. Frontend-only, no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build frontend, force-recreate, hard refresh."
