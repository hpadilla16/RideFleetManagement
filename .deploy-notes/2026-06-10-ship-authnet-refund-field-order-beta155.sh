#!/usr/bin/env bash
# v0.9.0-beta.155 — FIX: refund de Authorize.Net roto para transacciones SETTLED
#   bash .deploy-notes/2026-06-10-ship-authnet-refund-field-order-beta155.sh
#
# ⚠️  MONEY CODE (refund path de refundPayment) — APROBACIÓN EXPLÍCITA DE HECTOR
#     + revisión del diff línea a línea ANTES del push:
#     git diff --staged -- backend/src/modules/rental-agreements/rental-agreements.service.js
#
# BUG (reportado por Hector 2026-06-10, reserva 904984532861, pago via website):
#   Todo refund de una transacción YA SETTLED fallaba 400 con el error E00003 de
#   Authorize.Net: "The element 'transactionRequest'... has invalid child
#   element 'amount'". Tres intentos fallidos en prod hoy (21:16/21:26/21:36).
#
# CAUSA RAÍZ: el JSON API de Authorize.Net convierte a XML y el XSD es
#   SENSIBLE AL ORDEN (transactionType, amount, payment, ..., refTransId).
#   El código sembraba { transactionType, refTransId } y luego le APPENDEABA
#   amount y payment — el orden de inserción de keys en JS los dejaba DESPUÉS
#   de refTransId → schema inválido. El VOID (pendientes de settlement) nunca
#   lleva amount, por eso los voids sí funcionaban y esto no se había visto:
#   el refund settled NUNCA funcionó.
#
# FIX: construir transactionRequest en el orden del schema por rama
#   (void: transactionType+refTransId; refund: transactionType, amount,
#   payment(masked card + 'XXXX'), refTransId). CERO cambios de lógica:
#   mismos montos, mismas validaciones, mismos guards de monto/duplicado.
#
# FILES:
#   backend/src/modules/rental-agreements/rental-agreements.service.js
#   .deploy-notes/2026-06-10-ship-authnet-refund-field-order-beta155.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.155"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  ".deploy-notes/2026-06-10-ship-authnet-refund-field-order-beta155.sh"
)

# ── SYNTAX GATE. main.js incluido — el service está en su import path.
( cd backend \
  && node --check src/modules/rental-agreements/rental-agreements.service.js \
  && node --check src/main.js )
echo "node --check OK."

# ── GUARD DE ORDEN: verifica en el SOURCE que la rama refund construye las
# keys en el orden del schema (transactionType < amount < payment < refTransId).
node -e "
const fs = require('fs');
const src = fs.readFileSync('backend/src/modules/rental-agreements/rental-agreements.service.js','utf8');
const start = src.indexOf(\"transactionType: 'refundTransaction'\");
if (start < 0) { console.error('ABORT: refund branch not found'); process.exit(1); }
const block = src.slice(start, start + 600);
const iAmount = block.indexOf('amount: refundAmount.toFixed(2)');
const iPayment = block.indexOf('payment: {');
const iRef = block.indexOf('refTransId: transId');
if (!(iAmount > 0 && iPayment > iAmount && iRef > iPayment)) {
  console.error('ABORT: refund transactionRequest keys are NOT in schema order', { iAmount, iPayment, iRef });
  process.exit(1);
}
console.log('Schema-order guard OK (transactionType -> amount -> payment -> refTransId).');
"

# La rama void debe seguir SIN amount (void con amount = otro E00003).
node -e "
const fs = require('fs');
const src = fs.readFileSync('backend/src/modules/rental-agreements/rental-agreements.service.js','utf8');
const start = src.indexOf(\"transactionType: 'voidTransaction',\n          refTransId: transId\");
if (start < 0) { console.error('ABORT: void branch shape changed'); process.exit(1); }
console.log('Void-branch guard OK.');
"

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "⚠️  MONEY CODE — REVISA EL DIFF AHORA:"
echo "    git diff --staged -- backend/src/modules/rental-agreements/rental-agreements.service.js"
read -r -p "¿Diff revisado y APROBADO? Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(payments): Authorize.Net settled-transaction refunds always failed E00003

The Authorize.Net JSON API converts to XML and the XSD is order-sensitive:
transactionRequest children must follow the schema sequence (transactionType,
amount, payment, ..., refTransId). refundPayment() seeded the object with
{ transactionType, refTransId } and appended amount/payment afterwards, so JS
key-insertion order serialized amount AFTER refTransId and every refund of a
settled transaction was rejected with E00003 'invalid child element amount'.
Voids carry no amount, which is why pending-settlement voids worked and the
bug stayed hidden — settled refunds never worked.

Build the transactionRequest in schema order per branch. Zero logic changes:
same amounts, same validations, same duplicate/over-refund guards."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY backend, no migration):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + clean boot + /health 200."
echo "  smoke (la reserva 904984532861): reintentar el refund COMPLETO desde la UI."
echo "  - Si la transacción ya settleó -> debe procesar y aparecer la fila REFUND:<paymentId>."
echo "  - Si aún está capturedPendingSettlement -> hará VOID (completo). Igual de válido."
echo "  - Confirmar en el panel de Authorize.Net que el credit/void aparece."
