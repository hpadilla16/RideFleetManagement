#!/usr/bin/env bash
# v0.9.0-beta.159 — Edit Vehicle como modal DENTRO del perfil (pedido Hector)
#   bash .deploy-notes/2026-06-11-ship-profile-edit-modal-beta159.sh
#
# CODE-ONLY frontend (1 archivo). Sin migración. Cero money.
#
# Antes (beta.158): "Edit vehicle" en el perfil navegaba a /vehicles?edit=<id>,
# el agente editaba en la LISTA y quedaba varado ahí — tenía que volver al
# perfil a mano. Ahora: el modal de edición abre EN el perfil, save → PATCH →
# cierra → loadVehicle() refresca y los cambios se ven al instante. El
# deep-link ?edit= de /vehicles se queda (lo usa quien edita desde la lista).
#
# FILES:
#   frontend/src/app/vehicles/[id]/page.js
#   .deploy-notes/2026-06-11-ship-profile-edit-modal-beta159.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.159"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/vehicles/[id]/page.js"
  ".deploy-notes/2026-06-11-ship-profile-edit-modal-beta159.sh"
)

( cd frontend && npm run -s build >/dev/null 2>&1 ) && echo "frontend build OK." \
  || { echo "ABORT: frontend build failed — run 'cd frontend && npm run build' to see the error." >&2; exit 1; }

grep -nq "openEditModal" "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: modal missing." >&2; exit 1; }
grep -nq "saveEditModal" "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: save handler missing." >&2; exit 1; }
! grep -nq 'router.push(`/vehicles?edit=' "frontend/src/app/vehicles/[id]/page.js" || { echo "ABORT: old navigation still present." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(vehicles): edit modal lives on the profile page

'Edit vehicle' on the profile navigated to /vehicles?edit=<id> and stranded
the agent on the list after saving. The full edit form is now a modal on the
profile itself: save → PATCH → close → reload profile in place. The /vehicles
?edit deep-link stays for list-side editing.

Frontend-only, no migration, no money code."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. Droplet (CODE-ONLY frontend + backend rebuild estándar):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY + smoke: perfil -> Edit vehicle -> cambiar algo -> Save ->"
echo "  el modal cierra y el perfil refresca con el cambio, sin salir de la página."
