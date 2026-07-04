#!/usr/bin/env bash
# VozIA Fase 6 (RE-SCOPE) — link de pago + refunds + créditos + servicios (MONEY).
#   bash .deploy-notes/2026-07-04-ship-vozia-payments-fase6-rescope.sh
#   (tag default v0.9.0-beta.285 — override: TAG_OVERRIDE=v0.9.0-beta.NNN)
#
# ⚠️ MONEY + access-control. REVISIÓN LÍNEA A LÍNEA DE HECTOR. Depende de VozIA Fases 1-4
# (beta.284: cuenta de servicio, allowlist, idempotency, tabla IdempotencyKey) — deployar 284 ANTES.
# BACKEND-only, SIN migración nueva. CERO cambio para staff.
# Pipeline: re-build → Innovation (1 MUST + 3 SHOULD aplicados) → QA SHIP (137 tests) → Hector.
#
# CAMBIO DE ALCANCE (Hector, 2026-07-04): VozIA NUNCA cobra la tarjeta directamente
# (se QUITÓ card-on-file Y el pago manual — off del allowlist, handlers vuelven a human-only).
# En vez, VozIA ajusta el balance y manda al cliente un link para que pague solo. 4 capacidades
# vía 3 rutas, gateadas solo si isServiceAccount (author+ticketId + techo + AuditLog):
#   1) POST /api/reservations/:id/send-request-email {kind:'payment'} — email con link de auto-pago.
#      No mueve dinero. Sin idempotency. extraEmails IGNORADO para la cuenta de servicio (solo va
#      al email del customer — anti-phishing). Solo author+ticket + AuditLog.
#   2) POST /api/rental-agreements/:id/payments/:paymentId/refund — refund al gateway. Idempotency
#      OBLIGATORIA (kind:'payment', no-recycle → 409 reconcile). Techo voziaMaxRefundAmount (2000).
#      Encima del cap nativo (refund ≤ pago original, acumulado ≤ original). Tenant-scoped.
#   3) POST /api/reservations/:id/charges — crédito (monto negativo) o servicio/fee (positivo);
#      actualiza el balance vía addManualCharge/syncAgreementCharges (SIN gateway). Idempotency
#      OBLIGATORIA (kind:'charge'). Techo |monto| ≤ voziaMaxChargeLineAmount (2000). Rechaza
#      reservas CANCELLED.
# Access-control (crítico): /charges es ADMIN-only para humanos; se abre a la cuenta de servicio
# con `isAdmin || (isServiceAccount && guard OK)` — un AGENT humano SIGUE dando 403; solo el
# service account entra por su rama gateada. El role check de humanos NO se toca. El "ticket owner"
# lo enforcea VozIA (RFM solo graba author+ticketId).
#
# OPS: POST /api/admin/idempotency/resolve {userId,key,force?} (SUPER_ADMIN) — libera una key
# atascada IN_PROGRESS tras verificar el gateway. Por default NO borra keys COMPLETED (evita re-run;
# force:true para forzar). Cross-tenant a propósito (super-admin = operador de plataforma).
#
# HALLAZGOS DE INNOVATION APLICADOS EN ESTE MISMO SHIP:
#   MUST — idempotency kind 'charge' AHORA es no-recycle (409 reconcile): un crédito/servicio es
#     mutación ACUMULATIVA del balance; reciclar la key a las 24h y reintentar la misma = doble
#     crédito ($500 regalados). 'note' sigue reciclando; 'payment'/'refund'/'charge' no.
#   SHOULD — extraEmails ignorado para service account · resolve solo IN_PROGRESS salvo force ·
#     /charges rechaza reserva CANCELLED (evita fila huérfana sin recompute de balance).
#
# LO QUE HECTOR REVISA (money-critical):
#   1. service-payment-guards.js: checkServiceAccountRefund/Charge (author+ticket, techo cents-safe,
#      |monto| para créditos negativos), resolveVoziaCeiling (fail-safe LOW, nunca 0-lockout ni ilimitado).
#   2. reservations.routes.js /charges: el OR de access-control + guard + rechazo CANCELLED + dual audit.
#   3. rental-agreements.routes.js refund: idempotency obligatoria + guard + cap nativo intacto + tenant scope.
#   4. idempotency.js NO_RECYCLE_KINDS = {payment, refund, charge}; 'note' recicla.
#   5. allowlist: exactamente estas 3 rutas; card-on-file/manual/void/refund-alias/deposit/PATCH DENEGADOS.
#   6. NO ATÓMICO (aceptado): refund lee balance y luego pega al gateway sin lock; el cap nativo es la
#      línea primaria; velocity cap declinado por Hector.
#
# ── SMOKE (token de la cuenta VozIA de prueba) ──
#   send-request-email {kind:'payment'} sin author/ticket → 400; con ellos → 200 (email solo al customer).
#   refund sin Idempotency-Key → 400; monto > techo → 400; válido con key → 200 (repetir key = no-op).
#   /charges crédito -50 con author+ticket+key → 201 (balance baja); mismo con reserva CANCELLED → 400;
#     |monto| > 2000 → 400. Como AGENT humano → 403. Como ADMIN humano desde la UI → sin cambios.
#   card-on-file / payments/manual con token de servicio → 403 (fuera del allowlist).
#
# DEPLOY (BACKEND only, sin migración; DESPUÉS de beta.284):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#   # opcional por tenant: AppSetting voziaMaxRefundAmount / voziaMaxChargeLineAmount (default 2000 c/u)
#
# FILES:
#   backend/src/lib/service-account-allowlist.js
#   backend/src/lib/service-account-allowlist.test.mjs
#   backend/src/modules/rental-agreements/service-payment-guards.js
#   backend/src/modules/rental-agreements/service-payment-guards.test.mjs
#   backend/src/modules/rental-agreements/rental-agreements.routes.js
#   backend/src/modules/reservations/reservations.routes.js
#   backend/src/middleware/idempotency.js
#   backend/src/middleware/idempotency.test.mjs
#   backend/src/modules/admin/idempotency-admin.routes.js
#   backend/src/modules/admin/idempotency-admin.test.mjs
#   backend/src/main.js
#   backend/package.json
#   .deploy-notes/2026-07-04-ship-vozia-payments-fase6-rescope.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.285}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/lib/service-account-allowlist.js"
  "backend/src/lib/service-account-allowlist.test.mjs"
  "backend/src/modules/rental-agreements/service-payment-guards.js"
  "backend/src/modules/rental-agreements/service-payment-guards.test.mjs"
  "backend/src/modules/rental-agreements/rental-agreements.routes.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "backend/src/middleware/idempotency.js"
  "backend/src/middleware/idempotency.test.mjs"
  "backend/src/modules/admin/idempotency-admin.routes.js"
  "backend/src/modules/admin/idempotency-admin.test.mjs"
  "backend/src/main.js"
  "backend/package.json"
  ".deploy-notes/2026-07-04-ship-vozia-payments-fase6-rescope.sh"
)

# ── SANITY GATES ──
for f in "${FILES[@]}"; do case "$f" in backend/src/*.js) node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; };; esac; done
grep -q "charge" backend/src/middleware/idempotency.js && grep -q "NO_RECYCLE_KINDS = new Set(\['payment', 'refund', 'charge'\])" backend/src/middleware/idempotency.js || { echo "ABORT: 'charge' no está en NO_RECYCLE_KINDS" >&2; exit 1; }
grep -q "send-request-email" backend/src/lib/service-account-allowlist.js || { echo "ABORT: allowlist sin link de pago" >&2; exit 1; }
# manual/card-on-file NO deben ser entradas ACTIVAS del allowlist (sí pueden estar en el
# bloque de comentarios RESERVED). Una entrada activa empieza con [ indentado, sin //.
! grep -qE "^[[:space:]]*\['POST', '/api/rental-agreements/:id/payments/(manual|charge-card-on-file)'\]" backend/src/lib/service-account-allowlist.js || { echo "ABORT: una ruta de cobro directo sigue ACTIVA en el allowlist" >&2; exit 1; }
grep -q "assertServiceAccountChargeAllowed\|assertServiceAccountRefundAllowed" backend/src/modules/reservations/reservations.routes.js || { echo "ABORT: /charges sin guard de servicio" >&2; exit 1; }
( cd backend && npm run test:vozia-payments && npm run test:idempotency && npm run test:admin-idempotency && npm run test:service-auth && npm run test:reservations && npm run test:rental-agreements ) || { echo "ABORT: tests fallaron" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "⚠️  MONEY + access-control: revisa el diff línea a línea antes de responder y."
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(vozia): Fase 6 re-scope — payment link + refunds + credits/services (no direct card charge)

Hector re-scope 2026-07-04: VozIA never captures a card directly. Removed the
two direct-charge routes (payments/manual + charge-card-on-file) from the
service-account allowlist and reverted those handlers to human-only. VozIA now
adjusts the balance and sends the customer a self-pay link, via three routes
gated for isServiceAccount (author+ticketId + per-tenant ceiling + AuditLog):
send-request-email (payment link, extraEmails ignored for the service account,
no money), payments/:paymentId/refund (gateway refund, idempotency required,
ceiling voziaMaxRefundAmount, native refund<=original untouched), and
/reservations/:id/charges for credits(negative)/services(positive) via
addManualCharge (ceiling voziaMaxChargeLineAmount, rejects CANCELLED). The
/charges admin-only role check is widened ONLY for the service account
(isAdmin || (isServiceAccount && guard)); a human AGENT still 403s. Idempotency
kinds payment/refund/charge are non-recyclable (a charge is a cumulative balance
mutation — recycling a key after TTL would double-apply a credit); note still
recycles. New SUPER_ADMIN ops endpoint to free a wedged IN_PROGRESS key
(COMPLETED left intact unless force). Ticket ownership enforced by VozIA; RFM
records author+ticketId. No migration. QA SHIP, 137 tests; Innovation MUST+3
SHOULD applied."
git tag "$TAG"
git push origin "$BRANCH" "$TAG"
echo "Pushed $TAG. Deployar DESPUÉS de beta.284. Droplet: build BACKEND → recreate backend+worker."
