#!/usr/bin/env bash
# v0.9.0-beta.167 — CITATIONS UI (página /citations en el software)
#   bash .deploy-notes/2026-06-14-ship-citations-ui-beta167.sh
#
# FRONTEND-ONLY (sin backend, sin migración). Los endpoints ya existen (beta.163):
#   GET /api/citations · /:id · POST /:id/review · /manual-import · /vehicle/:id.
#
# QUÉ ENTRA:
#   • frontend/src/app/citations/page.js (NUEVO): banner + KPIs (Total / Needs Review /
#     Outstanding $ / Matched), filtros (status, source, plate, review-only), tabla
#     (citation# · vehículo+reserva · fecha · agencia+violación · source · monto · status),
#     acciones de review (Confirm / Dispute / Void), import manual, scope super-admin.
#   • AppShell.jsx: nav item '/citations' (adminOnly).
#   • locales en/es: nav.citations = "Citations" / "Multas".
#
# Deploy: build + force-recreate del frontend → HARD REFRESH en el browser.
#
# FILES:
#   frontend/src/app/citations/page.js
#   frontend/src/components/AppShell.jsx
#   frontend/src/locales/en.json
#   frontend/src/locales/es.json
#   .deploy-notes/2026-06-14-ship-citations-ui-beta167.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.167"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/citations/page.js"
  "frontend/src/components/AppShell.jsx"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  ".deploy-notes/2026-06-14-ship-citations-ui-beta167.sh"
)

# ── GATES
node -e "JSON.parse(require('fs').readFileSync('frontend/src/locales/en.json'));JSON.parse(require('fs').readFileSync('frontend/src/locales/es.json'));console.log('locales JSON valid')"
grep -nq "href: '/citations'" frontend/src/components/AppShell.jsx || { echo "ABORT: nav item missing." >&2; exit 1; }
grep -nq '"citations":' frontend/src/locales/en.json || { echo "ABORT: en label missing." >&2; exit 1; }
grep -nq '"citations":' frontend/src/locales/es.json || { echo "ABORT: es label missing." >&2; exit 1; }
grep -nq "api('/api/citations" frontend/src/app/citations/page.js || grep -nq "/api/citations" frontend/src/app/citations/page.js || { echo "ABORT: page not wired to API." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): citations UI page (/citations)

- New /citations page: KPIs + filters (status/source/plate) + table (citation#, vehicle+
  reservation, date, agency+violation, source, amount, status) + review actions
  (Confirm/Dispute/Void) + manual import. Super-admin tenant scope.
- Nav item (adminOnly) + en/es labels. Frontend-only; backend endpoints exist since beta.163."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy: frontend build + force-recreate + HARD REFRESH."
echo "Verify: abre /citations en el software (con corpus/super-admin) → ves las 10 multas."
