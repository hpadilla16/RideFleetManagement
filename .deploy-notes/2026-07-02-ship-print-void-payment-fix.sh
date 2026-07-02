#!/usr/bin/env bash
# Print agreement: pagos VOID ya no cuentan como "Amount Paid" (bug RES-756256).
#   bash .deploy-notes/2026-07-02-ship-print-void-payment-fix.sh
#   (tag default v0.9.0-beta.280 — override: TAG_OVERRIDE=v0.9.0-beta.NNN)
#
# BACKEND-only, SIN migración. Documento-only (el rollup paidAmount/balance siempre estuvo bien).
#
# BUG (Hector, 2026-07-02): admin dio VOID a un pago y se actualizó en todos lados MENOS en el
# print del agreement: el contrato mostraba el balance adeudado Y a la vez el pago anulado como
# cobrado. Causa: agreementPrintContext sumaba paidAmountForPrint excluyendo solo AUTH_HOLD —
# sin filtrar status. El rollup (recomputeAgreementPaidAndBalance), el fee engine y
# structuredReservationPayments filtran status='PAID'; el print era el ÚNICO camino sin filtro.
#
# FIX (rental-agreements.service.js ~línea 3006): paidAmountForPrint ahora refleja el filtro
# autoritativo exacto — solo filas status PAID y method != AUTH_HOLD. Las filas VOID siguen
# imprimiéndose en la tabla de pagos con su status (registro), igual que los AUTH_HOLD.
# Los REFUND no cambian: postean como fila negativa y se restan solos.
#
# AFECTADOS verificados en prod (retroactivo automático — el print se renderiza en vivo):
#   RES-756256 ($646.69) · TL-ZE40801823BA ($121.39, CLOSED) · RES-623949 ($731.94) ·
#   RES-818600 ($2.12, DRAFT). DB correcta en los 4; solo el documento imprimía mal.
#
# ── SMOKE ──
#   Reservations → RES-756256 → Print Agreement → "Amount Paid $0.00", "Amount Due $646.69",
#   y la fila del pago $646.69 con status VOID en la tabla.
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/src/modules/rental-agreements/rental-agreements.service.js
#   .deploy-notes/2026-07-02-ship-print-void-payment-fix.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.280}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  ".deploy-notes/2026-07-02-ship-print-void-payment-fix.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: node --check" >&2; exit 1; }
grep -q "String(p.status || 'PAID').toUpperCase() === 'PAID'" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: falta el filtro de status en el print" >&2; exit 1; }
( cd backend && npm run test:rental-agreements ) || { echo "ABORT: tests fallaron" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(rental-agreements): voided payments no longer count as Amount Paid on the printed agreement

agreementPrintContext summed paidAmountForPrint excluding only AUTH_HOLD, with
no status filter — a VOIDED payment printed as money collected while the same
document showed the balance still due (RES-756256; 3 more agreements affected,
DB rollups were always correct). The authoritative recompute, the fee engine
and structuredReservationPayments all filter status='PAID'; the print-side sum
now mirrors that exact filter. VOID rows still print in the payments table with
their status, same record-keeping treatment as AUTH_HOLD. Document-only —
renders live, so all affected agreements correct retroactively."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"
echo "Pushed $TAG. Droplet: build BACKEND → recreate backend+worker. Smoke: print de RES-756256 → Paid \$0.00 / Due \$646.69."
