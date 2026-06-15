#!/usr/bin/env bash
# v0.9.0-beta.179 — Citations: profile/detalle + lista mejorada + pay link
#   bash .deploy-notes/2026-06-15-ship-citation-detail-beta179.sh
#   (beta.178 lo tomó el commission-resync-sweep; este sube a 179.)
#
# BACKEND + FRONTEND, code-only, sin migración. NO money. Mockup aprobado:
# doc/citations-detail-mockup-2026-06-15.html
#
# QUÉ ENTRA:
#   - OCR extractor: ahora también captura paymentUrl (la URL de pago impresa en el
#     aviso) → se guarda en Citation.externalUrl (scheduler).
#   - citations.service: getDetail trae vehículo (year/make/model) + reserva
#     (customer firstName/lastName); nuevo getDocumentUrl (firma el scan del doc).
#   - citations.routes: GET /api/citations/:id/document (signed URL del scan).
#   - frontend /citations (lista): columnas nuevas Uploaded + Citation date +
#     Reservation, link "Pay ↗" (externalUrl, con fallback por agencia), filas
#     clicables → detalle, link "View".
#   - frontend /citations/[id] (NUEVO): profile completo — datos, Pay now, View
#     scanned notice, card de vehículo (link), card de reserva/renter (link),
#     acciones Confirm/Dispute/Void, timeline.
#
# Deploy: build backend + worker + FRONTEND + force-recreate. Hard refresh.
#   Smoke: /citations → click una fila → abre el detalle; Pay ↗ abre el portal;
#   View scanned notice abre el PDF subido.
#
# FILES:
#   backend/src/modules/citations/citation-ocr.extract.js
#   backend/src/modules/citations/citation-ocr.scheduler.js
#   backend/src/modules/citations/citations.service.js
#   backend/src/modules/citations/citations.routes.js
#   frontend/src/app/citations/page.js
#   frontend/src/app/citations/[id]/page.js
#   .deploy-notes/2026-06-15-ship-citation-detail-beta179.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.179"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/citations/citation-ocr.extract.js"
  "backend/src/modules/citations/citation-ocr.scheduler.js"
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/citations/citations.routes.js"
  "frontend/src/app/citations/page.js"
  "frontend/src/app/citations/[id]/page.js"
  ".deploy-notes/2026-06-15-ship-citation-detail-beta179.sh"
)

# ── GATES
node --check backend/src/modules/citations/citation-ocr.extract.js
node --check backend/src/modules/citations/citation-ocr.scheduler.js
node --check backend/src/modules/citations/citations.service.js
node --check backend/src/modules/citations/citations.routes.js
grep -nq "paymentUrl" backend/src/modules/citations/citation-ocr.extract.js || { echo "ABORT: paymentUrl falta en el extractor." >&2; exit 1; }
grep -nq "getDocumentUrl" backend/src/modules/citations/citations.service.js || { echo "ABORT: getDocumentUrl falta." >&2; exit 1; }
grep -nq "/:id/document" backend/src/modules/citations/citations.routes.js || { echo "ABORT: ruta document falta." >&2; exit 1; }
grep -nq "Citation date" frontend/src/app/citations/page.js || { echo "ABORT: columnas nuevas faltan en la lista." >&2; exit 1; }
test -f "frontend/src/app/citations/[id]/page.js" || { echo "ABORT: página de detalle falta." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): citation detail page + enhanced list + pay link

New /citations/[id] profile (all fields, Pay now, View scanned notice, vehicle +
reservation cards, review actions, timeline). List gains Uploaded + Citation date +
Reservation columns, a Pay link, and clickable rows. OCR now captures the printed
paymentUrl into Citation.externalUrl (with an agency fallback in the UI). Code-only.
Mockup: doc/citations-detail-mockup-2026-06-15.html"
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh /citations."
