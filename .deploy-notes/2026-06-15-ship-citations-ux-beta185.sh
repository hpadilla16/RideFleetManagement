#!/usr/bin/env bash
# v0.9.0-beta.185 — Citations UX (mejora #3): overflow + Undo + Incoming docs/retry
#   + umbral de confianza por-tenant + tile de Citations en el dashboard
#   bash .deploy-notes/2026-06-15-ship-citations-ux-beta185.sh
#   (consolida lo que iba en 184+185: tocan los mismos archivos, va en un solo tag.)
#
# BACKEND + FRONTEND, code-only, sin migración. NO money.
#
# QUE ENTRA:
#   - Overflow: la tabla de /citations va en div overflow-x:auto (ya no se sale).
#   - Undo: deshacer un Confirm/Dispute/Void accidental (lista + detalle) → NEEDS_REVIEW.
#   - Incoming documents: panel con los avisos subidos y su estado de OCR + View scan
#     + Retry (citations.service.retryDocument + POST /documents/:id/retry).
#   - Umbral de confianza POR-TENANT: campo en Settings → Citations OCR (AI)
#     ("Min OCR confidence"); el worker lo usa por tenant (fallback env/70).
#   - Dashboard: tile "Citations" (needs review + outstanding $) → citations.service
#     .dashboardSummary + GET /api/citations/summary; soft-fail si el módulo está off.
#
# Deploy: build backend + worker + FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   backend/src/modules/citations/citations.service.js
#   backend/src/modules/citations/citations.routes.js
#   backend/src/modules/citations/citation-ocr.scheduler.js
#   backend/src/modules/settings/settings.service.js
#   frontend/src/app/citations/page.js
#   frontend/src/app/citations/[id]/page.js
#   frontend/src/app/settings/page.js
#   frontend/src/app/page.js
#   .deploy-notes/2026-06-15-ship-citations-ux-beta185.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.185"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/citations/citations.routes.js"
  "backend/src/modules/citations/citation-ocr.scheduler.js"
  "backend/src/modules/settings/settings.service.js"
  "frontend/src/app/citations/page.js"
  "frontend/src/app/settings/page.js"
  "frontend/src/app/page.js"
  ".deploy-notes/2026-06-15-ship-citations-ux-beta185.sh"
)

# ── GATES
node --check backend/src/modules/citations/citations.service.js
node --check backend/src/modules/citations/citations.routes.js
node --check backend/src/modules/citations/citation-ocr.scheduler.js
node --check backend/src/modules/settings/settings.service.js
grep -nq "async retryDocument" backend/src/modules/citations/citations.service.js || { echo "ABORT: retryDocument falta." >&2; exit 1; }
grep -nq "async dashboardSummary" backend/src/modules/citations/citations.service.js || { echo "ABORT: dashboardSummary falta." >&2; exit 1; }
grep -nq "documents/:id/retry" backend/src/modules/citations/citations.routes.js || { echo "ABORT: ruta retry falta." >&2; exit 1; }
grep -nq "citationsRouter.get('/summary'" backend/src/modules/citations/citations.routes.js || { echo "ABORT: ruta summary falta." >&2; exit 1; }
grep -nq "confidenceMin" backend/src/modules/settings/settings.service.js || { echo "ABORT: confidenceMin falta en settings." >&2; exit 1; }
grep -nq "cfg.confidenceMin" backend/src/modules/citations/citation-ocr.scheduler.js || { echo "ABORT: umbral por-tenant falta en scheduler." >&2; exit 1; }
grep -nq "overflowX: 'auto'" frontend/src/app/citations/page.js || { echo "ABORT: overflow falta." >&2; exit 1; }
# (el detalle [id]/page.js ya se commiteó en 184; su redseño va en 186)
grep -nq "Incoming docs" frontend/src/app/citations/page.js || { echo "ABORT: Incoming docs falta." >&2; exit 1; }
grep -nq "review('REJECT')" "frontend/src/app/citations/[id]/page.js" || { echo "ABORT: Undo detalle falta (de 184)." >&2; exit 1; }
grep -nq "Min OCR confidence" frontend/src/app/settings/page.js || { echo "ABORT: campo confianza falta en Settings." >&2; exit 1; }
grep -nq "citations/summary" frontend/src/app/page.js || { echo "ABORT: tile Citations falta en el dashboard." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): UX pack — overflow fix, undo, incoming-docs queue/retry, per-tenant OCR confidence, dashboard tile

Table overflow -> horizontal scroll. Undo an accidental Confirm/Dispute/Void back to
NEEDS_REVIEW. Incoming-documents panel (uploaded scans + OCR status, View scan, Retry).
Per-tenant 'Min OCR confidence' in Settings used by the OCR worker. Dashboard Citations
tile (needs review + outstanding) via /api/citations/summary. Code-only."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh."
