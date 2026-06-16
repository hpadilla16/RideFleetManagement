#!/usr/bin/env bash
# v0.9.0-beta.187 — Citations: extraer instrucciones de pago (Notice#/PIN/phone)
#   + mostrarlas en el detalle + link al perfil del vehículo
#   bash .deploy-notes/2026-06-15-ship-citation-payment-info-beta187.sh
#
# BACKEND + FRONTEND, code-only, sin migración. NO money.
#
# QUE ENTRA:
#   - OCR extractor: además captura paymentFields (lo que el aviso pide para PAGAR,
#     ej. Notice #, PIN, Account #, Reference #, ZIP — label/value verbatim) y
#     paymentPhone. Se guardan en el payload del OCR (sourcePayloadJson, sin migración).
#   - citations.service.getDetail: expone paymentFields + paymentPhone parseados.
#   - Detalle (/citations/[id]): panel "What you need to pay" con cada campo + botón
#     Copiar (y el teléfono) — para pagar sin volver al documento a buscarlos.
#   - Fix: el botón "Profile" del vehículo ahora va a /vehicles/:id (perfil), no a
#     la lista /vehicles.
#
# OJO: las citations ya ingeridas no traen paymentFields (su payload viejo no los
#   tenía); aplican a NUEVOS uploads (re-subir el aviso los llena).
#
# Deploy: build backend + worker + FRONTEND + force-recreate + HARD REFRESH.
#
# FILES:
#   backend/src/modules/citations/citation-ocr.extract.js
#   backend/src/modules/citations/citation-ocr.scheduler.js
#   backend/src/modules/citations/citations.service.js
#   frontend/src/app/citations/[id]/page.js
#   .deploy-notes/2026-06-15-ship-citation-payment-info-beta187.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.187"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/citations/citation-ocr.extract.js"
  "backend/src/modules/citations/citation-ocr.scheduler.js"
  "backend/src/modules/citations/citations.service.js"
  "frontend/src/app/citations/[id]/page.js"
  ".deploy-notes/2026-06-15-ship-citation-payment-info-beta187.sh"
)

# ── GATES
node --check backend/src/modules/citations/citation-ocr.extract.js
node --check backend/src/modules/citations/citation-ocr.scheduler.js
node --check backend/src/modules/citations/citations.service.js
grep -nq "paymentFields" backend/src/modules/citations/citation-ocr.extract.js || { echo "ABORT: paymentFields no está en el extractor." >&2; exit 1; }
grep -nq "paymentFields" backend/src/modules/citations/citations.service.js || { echo "ABORT: getDetail no expone paymentFields." >&2; exit 1; }
grep -nq "What you need to pay" "frontend/src/app/citations/[id]/page.js" || { echo "ABORT: panel de pago falta en el detalle." >&2; exit 1; }
grep -nq "vehicles/\${c.vehicle.id}" "frontend/src/app/citations/[id]/page.js" || { echo "ABORT: link al perfil del vehículo no corregido." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): extract & surface how-to-pay info (Notice#/PIN/phone) + vehicle profile link

OCR now extracts paymentFields (the verbatim Notice #, PIN, account/reference numbers
the notice requires to pay) + paymentPhone, stored in the OCR payload. The citation
detail shows a 'What you need to pay' panel with copy buttons so staff can pay without
reopening the document. Also fix the Vehicle 'Profile' link to /vehicles/:id."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker+frontend, force-recreate, hard refresh. Re-upload a notice to populate pay fields."
