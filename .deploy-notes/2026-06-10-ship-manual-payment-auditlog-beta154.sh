#!/usr/bin/env bash
# v0.9.0-beta.154 — AUDIT LOG de pago manual del checkin wizard (1 archivo).
#   bash .deploy-notes/2026-06-10-ship-manual-payment-auditlog-beta154.sh
#
# ⚠️  MONEY-ADYACENTE — HECTOR: REVISA EL DIFF LÍNEA A LÍNEA ANTES DEL PUSH.
#     git diff --staged -- backend/src/modules/rental-agreements/checkin-close.service.js
#     El cambio vive DENTRO de applyManualPayment() (checkin-close), pero NO
#     toca ningún cálculo de dinero: paidAmount/balance/recompute quedan
#     byte-idénticos. Solo cambia (a) un select que ahora trae reservationId y
#     (b) el bloque del auditLog. Aun así: es el archivo del wizard de cobro.
#
# BUG (registro: fleet-backend-prod__checkin-manual-payment-auditlog-missing-reservation, P3):
#   applyManualPayment() hacía auditLog.create({ reservationId: null }) pero
#   AuditLog.reservationId es REQUERIDO en el schema → el create SIEMPRE tiraba
#   y el `.catch(() => {})` se lo tragaba → ningún pago manual del checkin
#   wizard dejó jamás una fila de auditoría.
#
# FIX (espejo del patrón correcto en rental-agreements.service.js:3569):
#   - el findUnique que ya existía para `total` ahora también trae reservationId
#     (cero queries nuevas).
#   - auditLog.create usa agreement.reservationId (schema: requerido + @unique
#     en RentalAgreement, siempre presente).
#   - el .catch silencioso ahora hace logger.warn — el silencio fue exactamente
#     lo que escondió este bug.
#
# FILES:
#   backend/src/modules/rental-agreements/checkin-close.service.js
#   .deploy-notes/2026-06-10-ship-manual-payment-auditlog-beta154.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.154"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/rental-agreements/checkin-close.service.js"
  ".deploy-notes/2026-06-10-ship-manual-payment-auditlog-beta154.sh"
)

# ── SYNTAX GATE. main.js incluido — checkin-close está en su import path.
( cd backend \
  && node --check src/modules/rental-agreements/checkin-close.service.js \
  && node --check src/main.js )
echo "node --check OK."

# ── GUARDS — el fix está y la lógica de dinero NO cambió.
grep -nq "reservationId: agreement.reservationId" backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: audit fix missing." >&2; exit 1; }
grep -nq "select: { total: true, reservationId: true }" backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: select not extended." >&2; exit 1; }
grep -nq "manual-payment audit log failed" backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: silent catch still silent." >&2; exit 1; }
! grep -nq "reservationId: null,  // we don't have it" backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: old null write still present." >&2; exit 1; }
# La aritmética de dinero debe quedar intacta (firmas exactas):
grep -nq 'paidAmount: Number(totalPaid.toFixed(2))' backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: money math changed?!" >&2; exit 1; }
grep -nq 'const newBalance = Math.max(0, Number((Number(agreement.total || 0) - totalPaid).toFixed(2)))' backend/src/modules/rental-agreements/checkin-close.service.js || { echo "ABORT: balance math changed?!" >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "⚠️  REVISA EL DIFF AHORA:  git diff --staged -- backend/src/modules/rental-agreements/checkin-close.service.js"
read -r -p "¿Diff revisado línea a línea y aprobado? Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(checkin): manual-payment audit log was never written

applyManualPayment() created the AuditLog row with reservationId: null, but
AuditLog.reservationId is required — the create always threw and the silent
.catch swallowed it, so no manual check-in payment ever produced an audit row.

- Reuse the existing agreement lookup to also fetch reservationId (no new query)
- Write the audit row with agreement.reservationId (mirrors the pattern in
  rental-agreements.service.js manual-entry path)
- Replace the silent catch with logger.warn

No money math touched: paidAmount/balance recompute is byte-identical."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY backend, no migration):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + clean boot + /health 200."
echo "  smoke: aplicar un pago manual chiquito en el checkin wizard de una reserva"
echo "  de prueba -> debe aparecer la fila en AuditLog (action UPDATE, reason"
echo "  'Manual payment applied via checkin wizard...') y el balance igual que antes."
