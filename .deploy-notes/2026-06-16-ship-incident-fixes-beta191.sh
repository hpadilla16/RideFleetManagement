#!/usr/bin/env bash
# v0.9.0-beta.191 — Incident/Damage Report module: audit fixes (legal accuracy, P1 bugs,
#   lifecycle states, architectural cleanup).
#   bash .deploy-notes/2026-06-16-ship-incident-fixes-beta191.sh
#
# BACKEND + FRONTEND, code-only, SIN migración (los enums DISPUTED/RESOLVED/CLOSED/VOID ya
# existían en el schema desde beta.62). NO money.
#
# QUE ENTRA (sobre el módulo ya live):
#   PRECISIÓN LEGAL:
#     - preRentalCondition ya NO auto-afirma "delivered clean / no pre-existing damage";
#       usa las notas reales del check-out o queda en blanco para que el staff lo llene.
#     - rebuttalPoints: si hay rebuttalText del autor, lo usa (1 punto por línea); si no,
#       genera puntos neutrales basados en evidencia (sin afirmar hechos no documentados).
#     - UI: editores de Pre-rental condition (§2) y Chargeback rebuttal (§7) en el panel.
#   BUGS P1:
#     - reportNumber: cuenta exacta o sufijo `-N` (no startsWith greedy) + retry on P2002
#       (creates concurrentes ya no tiran 500).
#     - pullInspectionEvidence: ya no descarta fotos externas (refs con .url); signedUrlSafe
#       deja pasar URLs completas.
#     - lectura de inspección con scope del tenant (defense-in-depth).
#     - update(): valida los enums type/severity (antes un valor inválido = Prisma 500).
#   CICLO DE VIDA:
#     - nuevo POST /:id/status (ISSUED→DISPUTED/RESOLVED/CLOSED/VOID, con flujo guardado) +
#       botones en el panel para que los badges existentes funcionen.
#   LIMPIEZA:
#     - selección de cargos cableada: chargeIdsJson se LEE en §6 (fallback: todos los
#       seleccionados) + picker de cargos en el panel. serialize() expone chargeIds.
#     - edición inline de filas de evidencia (PATCH /:id/evidence/:evidenceId nuevo).
#     - revise() preserva takenAt (chain of custody no se resetea).
#     - BORRADO el wizard huérfano /reservations/[id]/incident-report/page.js (duplicaba el
#       panel; estaba untracked y sin link). El panel embebido es la única UI.
#
# Deploy: build backend + worker + FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   backend/src/modules/incident-report/incident-report.service.js
#   backend/src/modules/incident-report/incident-report.routes.js
#   frontend/src/components/incident/IncidentReportsPanel.jsx
#   .deploy-notes/2026-06-16-ship-incident-fixes-beta191.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.191"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/incident-report/incident-report.service.js"
  "backend/src/modules/incident-report/incident-report.routes.js"
  "frontend/src/components/incident/IncidentReportsPanel.jsx"
  ".deploy-notes/2026-06-16-ship-incident-fixes-beta191.sh"
)

# ── GATES
node --check backend/src/modules/incident-report/incident-report.service.js
node --check backend/src/modules/incident-report/incident-report.routes.js
( cd backend && node --test src/modules/incident-report/incident-report-pdf.test.mjs src/modules/incident-report/incident-report.service.test.mjs >/dev/null 2>&1 ) && echo "incident tests pass" || { echo "ABORT: incident tests failed" >&2; exit 1; }
grep -nq "async setStatus" backend/src/modules/incident-report/incident-report.service.js || { echo "ABORT: setStatus falta." >&2; exit 1; }
grep -nq "/:id/status" backend/src/modules/incident-report/incident-report.routes.js || { echo "ABORT: ruta status falta." >&2; exit 1; }
grep -nq "/:id/evidence/:evidenceId" backend/src/modules/incident-report/incident-report.routes.js || { echo "ABORT: ruta PATCH evidence falta." >&2; exit 1; }
grep -nq "Charges to include" frontend/src/components/incident/IncidentReportsPanel.jsx || { echo "ABORT: picker de cargos falta." >&2; exit 1; }
grep -nq "Chargeback rebuttal" frontend/src/components/incident/IncidentReportsPanel.jsx || { echo "ABORT: editor de rebuttal falta." >&2; exit 1; }
echo "Guards OK."

# Stage the wizard deletion if git is tracking it (untracked → no-op).
git rm --ignore-unmatch -- "frontend/src/app/reservations/[id]/incident-report/page.js" >/dev/null 2>&1 || true

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}" "frontend/src/app/reservations/[id]/incident-report/page.js"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(incident): audit fixes — legal accuracy, P1 bugs, lifecycle states, cleanup

Legal: pre-rental condition + rebuttal no longer auto-assert 'delivered clean / no
pre-existing damage' on a dispute document (use real inspection notes or author text).
Bugs: report-number race (retry on P2002) + non-greedy collision count; pull no longer
drops externally-hosted inspection photos; enum validation in update(); tenant-scoped
inspection read. Lifecycle: POST /:id/status (ISSUED→DISPUTED/RESOLVED/CLOSED/VOID) +
panel buttons. Cleanup: wired charge selection (chargeIdsJson read in §6 + picker),
inline evidence edit (PATCH /:id/evidence/:id), revise() preserves takenAt, deleted the
orphaned duplicate wizard page. No migration (enums already existed). NOT money."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh. Smoke: open a reservation → Incident reports → create → fill → certify → status transitions → print."
