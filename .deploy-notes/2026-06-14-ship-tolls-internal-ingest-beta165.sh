#!/usr/bin/env bash
# v0.9.0-beta.165 — TOLLS: endpoint interno de ingest (patrón droplet, desacopla SunPass de AutoExpreso)
#   bash .deploy-notes/2026-06-14-ship-tolls-internal-ingest-beta165.sh
#
# CODE-ONLY (sin migración, sin frontend). Plan: doc/sunpass-droplet-connector-plan-2026-06-14.md
#
# QUÉ ENTRA:
#   • tolls.routes.js: NUEVO tollsInternalRouter con POST /api/internal/tolls/ingest
#     (requireInternalToken, BACKEND_INTERNAL_TOKEN). Reusa createManualTransactions
#     (dedup por externalId + match placa/tag/sello+timestamp + asignación + charge sync).
#     Exige tollsEnabled. NO toca el matching ni añade vía de dinero nueva (parity con el
#     manual-import del staff que ya existe).
#   • main.js: monta /api/internal/tolls (sin requireAuth; el token guard va adentro).
#   El sweep de AutoExpreso en el worker queda EXACTAMENTE igual → un conector no depende del
#   otro. El adapter SunPass del droplet (Fase B) se aplica APARTE y empuja a este endpoint.
#
# SIN MIGRACIÓN. tollsInternalRouter es un import nuevo en main.js → DEBE estar en FILES[] y
# checar con node --check (causa #1 de boot crashes).
#
# FILES:
#   backend/src/modules/tolls/tolls.routes.js
#   backend/src/main.js
#   doc/sunpass-droplet-connector-plan-2026-06-14.md
#   .deploy-notes/2026-06-14-ship-tolls-internal-ingest-beta165.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.165"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/tolls/tolls.routes.js"
  "backend/src/main.js"
  "doc/sunpass-droplet-connector-plan-2026-06-14.md"
  ".deploy-notes/2026-06-14-ship-tolls-internal-ingest-beta165.sh"
)

# ── SYNTAX GATES (todo import top-level de main.js debe checar).
( cd backend \
  && node --check src/modules/tolls/tolls.routes.js \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."

# ── GUARDS (router + mount + reuse presentes; AutoExpreso intacto).
grep -nq "export const tollsInternalRouter" backend/src/modules/tolls/tolls.routes.js || { echo "ABORT: tollsInternalRouter missing." >&2; exit 1; }
grep -nq "tollsInternalRouter.post('/ingest'" backend/src/modules/tolls/tolls.routes.js || { echo "ABORT: /ingest route missing." >&2; exit 1; }
grep -nq "createManualTransactions" backend/src/modules/tolls/tolls.routes.js || { echo "ABORT: ingest must reuse createManualTransactions." >&2; exit 1; }
grep -nq "requireInternalToken" backend/src/modules/tolls/tolls.routes.js || { echo "ABORT: internal token guard missing." >&2; exit 1; }
grep -nq "tollsInternalRouter" backend/src/main.js || { echo "ABORT: tollsInternalRouter not imported in main.js." >&2; exit 1; }
grep -nq "app.use('/api/internal/tolls'" backend/src/main.js || { echo "ABORT: /api/internal/tolls not mounted." >&2; exit 1; }
grep -nq "provider: 'AUTOEXPRESO'" backend/src/modules/tolls/tolls.service.js || { echo "ABORT: AutoExpreso sweep changed unexpectedly." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(tolls): internal ingest endpoint (droplet pattern, decouples SunPass from AutoExpreso)

- POST /api/internal/tolls/ingest (BACKEND_INTERNAL_TOKEN) reuses createManualTransactions:
  dedup by externalId + plate/tag/sello+timestamp match + assignment + reservation charge sync.
- AutoExpreso in-worker sweep unchanged — connectors no longer block each other.
- No migration, no new money path (parity with existing staff manual-import).
- Plan: doc/sunpass-droplet-connector-plan-2026-06-14.md. SunPass droplet adapter ships separately."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy backend (build + force-recreate). Sin migración."
echo "Verify: curl -s -o /dev/null -w '%{http_code}\\n' -X POST \\"
echo "  https://ridefleetmanager.com/api/internal/tolls/ingest   # → 401 (montado, sin token)"
echo "Y que el worker siga: docker logs fleet-worker-prod | grep -i 'auto sync scheduler started'"
