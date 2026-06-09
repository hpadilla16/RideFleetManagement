#!/usr/bin/env bash
# v0.9.0-beta.144 — Mileage history UI: Spanish → English strings.
#   bash .deploy-notes/2026-06-09-ship-mileage-history-i18n-en-beta144.sh
#
# Stacks on beta.143. FRONTEND-ONLY, no migration, no money/access-control code.
#
# WHAT: the vehicle profile is an English UI, but the beta.143 mileage-history
# section + Adjust-mileage modal shipped in Spanish. Translate every visible
# string to English (headings, table headers, buttons, helper text, toasts,
# source labels). No logic change.
#
# FILES:
#   frontend/src/app/vehicles/[id]/page.js
#   .deploy-notes/2026-06-09-ship-mileage-history-i18n-en-beta144.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.144"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH (must be at the beta.143 tip)"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/vehicles/[id]/page.js"
  ".deploy-notes/2026-06-09-ship-mileage-history-i18n-en-beta144.sh"
)

# ── GUARDS: the English strings are present and no Spanish leftovers remain.
PAGE="frontend/src/app/vehicles/[id]/page.js"
grep -nq "Mileage History" "$PAGE" || { echo "ABORT: 'Mileage History' heading missing." >&2; exit 1; }
grep -nq "Adjust mileage" "$PAGE" || { echo "ABORT: 'Adjust mileage' button missing." >&2; exit 1; }
if grep -nE "Millaje|Ajustar millaje|Historial de Millaje|Fuente|Telemática|Importado|Cancelar|Guardar|Ingresa un millaje|todavía" "$PAGE"; then
  echo "ABORT: Spanish strings still present in the mileage UI." >&2; exit 1;
fi
echo "Guards OK (English strings present, no Spanish leftovers)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "Review:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "i18n(vehicles): mileage history UI strings to English

The vehicle profile is an English UI but the beta.143 mileage-history section +
Adjust-mileage modal shipped in Spanish. Translate all visible strings to
English (headings, table headers, buttons, helper text, toasts, source labels).
No logic change. Frontend-only, no migration."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (FRONTEND-ONLY — no migration):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy + /health 200 + HARD refresh (Cmd+Shift+R) the"
echo "        vehicle profile → 'Mileage History', 'Adjust mileage', table headers all in English."
