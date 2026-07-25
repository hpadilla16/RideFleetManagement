#!/usr/bin/env bash
# v0.9.0-beta.343 — Kiosk B5 FASE 1: mitad defensiva del pago (SIN gateway).
#   bash .deploy-notes/2026-07-25-ship-kiosk-b5-phase1-beta343.sh
#
# BACKEND, CON migración ADITIVA (20260724_kiosk_b5_phase1). Pipeline: Innovation + QA SHIP.
# Diff de dinero revisado línea por línea por Hector (gate #2) 2026-07-25.
# Suites: kiosk 148/148 · reservations 145/145 · rental-agreements 33/33 · payments 11/11 ·
# payment-refs 6/6 · stale-preauth 4/4 · checkout-session 2/2 · prisma validate · import walk.
#
# ⚠️ CERO CÓDIGO DE GATEWAY. No hay cliente HPP, ni llamadas a iPOS/Spin, ni void/refund
# reales. Esta fase es puramente defensiva + un FIX de un bug vivo. La Fase 2 (HPP,
# poll/webhook, PreAuth, refund, branch settled↔void) sigue bloqueada esperando al rep:
# "¿Están habilitados Void y Refund a nivel de TPN para el 816026739983 en Transact?"
#
# QUÉ (todo del design v2 + los gates):
#   1. FIX MONEY-ADJACENT (QA B1): `voidStalePreauths()` ya NO estampa depositHoldVoidedAt
#      sin llamar al gateway. Ese sello mentía (el hold seguía VIVO en la tarjeta 7-30 días)
#      Y escondía la fila de todo sweep futuro (todos filtran depositHoldVoidedAt != null).
#      Ahora levanta PaymentOpsFlag(STRANDED_DEPOSIT_HOLD, NOT_ATTEMPTED). Estrictamente más
#      honesto; el counter no pierde ninguna capacidad (el sello viejo no liberaba nada).
#      ⚠️ OPS: los holds viejos dejan de verse como "liberados" en el UI — avisar al equipo.
#   2. Piso de idempotencia: índice único PARCIAL sobre (reservationId, reference) SOLO para
#      referencias de máquina (IPOS:/AUTHNET:/SPIN:). Un unique general es IMPOSIBLE: prod
#      tiene 144 filas en 72 grupos de refs tecleadas por staff (pagos dobles legítimos).
#      Verificado 0 duplicados en el scope de máquina. + colapso de P2002 en el ledger
#      canónico (red pura: solo P2002 + referencia no vacía; todo lo demás re-lanza).
#   3. Guard seam del kill-switch: KIOSK_PAYMENT_LIVE (default OFF, double-key en prod) +
#      tope de monto server-side + allowlist de reserva + pin de device/location + flag
#      auto-expirable. withKioskPaymentGuard(ctx, fn) — el pago futuro es estructuralmente
#      inalcanzable sin pasar los 6 guards (test lo pinea). El tope se aplica al monto
#      REALMENTE enviado (bajar kioskDepositConfig a mano NO es un control: reservation-wins).
#   4. Un solo payment intent por sesión + refs retiradas RETENIDAS (iPOS no permite cancelar
#      un link → un QR viejo puede pagarse; siempre se detecta y encola, nunca huérfano).
#   5. Cola de ops de pago con estados reales (NOT_ATTEMPTED / GATEWAY_FAILED / RESOLVED),
#      dedupe por clave natural, y GATEWAY_FAILED nunca se degrada.
#   6. CI: beta-ci.yml corre 3 suites DB-free (el CI no corría NINGUNA suite; el `npm test`
#      agregado se cuelga en la entrada 3 — arreglo aparte, task_b78075c0).
#
# ⚠️ COORDINACIÓN — package.json: la sesión de task_b78075c0 (arreglar el `npm test` colgado,
# 27 entradas sin --test-force-exit) toca el MISMO archivo. Este tag añade al final del chain
# `test:kiosk`, `test:payment-refs`, `test:stale-preauth`, mete payment-idempotency en
# test:reservations, kiosk-payment-phase1 en test:kiosk, y --test-force-exit a
# test:checkout-session. Al mergear esa rama: CONSERVAR estas entradas (no revertirlas).
#
# ── PRE-FLIGHT OBLIGATORIO (QA MAJOR B) — correr JUSTO ANTES de la migración ──
#   SELECT "reservationId", reference, COUNT(*) FROM "ReservationPayment"
#   WHERE reference LIKE 'IPOS:%' OR reference LIKE 'AUTHNET:%' OR reference LIKE 'SPIN:%'
#   GROUP BY 1,2 HAVING COUNT(*) > 1;
#   Esperado: 0 filas. Si hay alguna, la migración ABORTA (rollback limpio, pero deploy
#   fallido). Verificado 0 el 2026-07-25; re-verificar por si entró una en el medio.
#
# DEPLOY (BACKEND + migración; el frontend no cambia):
#   bash scripts/env-diff-check.sh
#   git fetch --tags && git checkout v0.9.0-beta.343
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   # La migración 20260724_kiosk_b5_phase1 es NUEVA (nunca aplicada) → corre fresca.
#   # Índice único sobre ReservationPayment: lock ACCESS EXCLUSIVE breve (tabla chica) →
#   # aplicar en ventana de bajo tráfico.
#   # Post-deploy: 3 contenedores healthy + boot limpio + /health 200 + verificar en
#   # information_schema/pg_indexes que existan los 3 índices nuevos.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.343"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }

FILES=(
  backend/prisma/migrations/20260724_kiosk_b5_phase1/migration.sql
  backend/prisma/schema.prisma
  backend/src/lib/payment-references.js
  backend/src/lib/payment-references.test.mjs
  backend/src/lib/single-flight.js
  backend/src/modules/kiosk/kiosk-payment-guards.js
  backend/src/modules/kiosk/kiosk-payment-intent.service.js
  backend/src/modules/kiosk/kiosk-payment-phase1.test.mjs
  backend/src/modules/payment-gateway/payment-ops-queue.service.js
  backend/src/modules/payment-gateway/payment-gateway.routes.js
  backend/src/modules/reservations/payment-idempotency.test.mjs
  backend/src/modules/reservations/reservation-pricing.service.js
  backend/src/modules/checkout-session/checkout-session.scheduler.js
  backend/src/modules/checkout-session/stale-preauth-flag.test.mjs
  backend/src/modules/customer-portal/customer-portal.routes.js
  backend/package.json
  .github/workflows/beta-ci.yml
  doc/kiosk-b5-payment-design-2026-07-16.md
  .deploy-notes/2026-07-25-ship-kiosk-b5-phase1-beta343.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"

# GUARD 1 (lección 315): schema.prisma stageado no puede traer campos de otro workstream.
FOREIGN="$(git diff --cached v0.9.0-beta.342 -- backend/prisma/schema.prisma 2>/dev/null | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -viE 'paymentOps|paymentIntent|PaymentOpsFlag|PaymentOpsKind|PaymentOpsStatus|STRANDED_DEPOSIT_HOLD|ORPHAN_PAYMENT|ROLLBACK_FAILED|CARD_ON_FILE_FAILED|NAME_MISMATCH_REVIEW|NOT_ATTEMPTED|GATEWAY_FAILED|RESOLVED|^\+\s*//|^\+$|@@|^\+\}|tenantId|reservationId|rentalAgreementId|gatewayRef|amount|note|lastError|attempts|createdAt|updatedAt|resolvedAt|resolvedBy|kind|status|id |reference|raisedAt|kioskSessionId|Decimal|String|DateTime|Int |Json' || true)"
if [ -n "$FOREIGN" ]; then
  echo "ABORT: schema.prisma stageado trae líneas ajenas a B5 Fase 1:" >&2; echo "$FOREIGN" >&2
  git reset -q -- "${FILES[@]}"; exit 1
fi

# GUARD 2: cero código de gateway en lo stageado (esta fase NO llama a iPOS/Spin).
for f in backend/src/modules/kiosk/kiosk-payment-guards.js backend/src/modules/kiosk/kiosk-payment-intent.service.js backend/src/modules/payment-gateway/payment-ops-queue.service.js backend/src/lib/single-flight.js; do
  if git show ":$f" | grep -vE '^\s*(\*|//)' | grep -qE "from '.*(ipos-transact-client|spin-client|ipos-auth)"; then
    echo "ABORT: $f importa un cliente de gateway — la Fase 1 no debe llamar al gateway" >&2
    git reset -q -- "${FILES[@]}"; exit 1
  fi
done
echo "GUARDS OK (schema solo-B5, cero imports de gateway)"
echo "Shipping $TAG from $BRANCH"

git commit -m "fix(payments): B5 Phase 1 — stop falsely voiding deposit holds + gateway idempotency floor

MONEY-ADJACENT. Reviewed line-by-line by Hector (gate #2).

1) voidStalePreauths() stamped depositHoldVoidedAt WITHOUT any gateway call:
   the DB claimed the customer's hold was released while it stayed live on
   their card for 7-30 days, and the stamp permanently hid the row from every
   future sweep (all sweeps skip depositHoldVoidedAt != null). The false stamp
   is removed; the sweep now raises a visible PaymentOpsFlag for staff. No
   counter capability is lost — the old stamp released nothing.
2) Partial unique index on (reservationId, reference) for MACHINE references
   only (IPOS:/AUTHNET:/SPIN:) — a blanket constraint is impossible because
   staff legitimately repeat manual refs (144 rows / 72 groups in prod). Plus a
   P2002 collapse in the canonical ledger writer: a pure safety net that is
   byte-identical for every existing caller.
3) Kill-switch guard seam for the future payment call (amount ceiling bound to
   the amount actually sent, reservation allowlist, device/location pin,
   auto-expiring flag), one payment intent per kiosk session with retired refs
   retained (iPOS links cannot be cancelled, so an old QR must stay
   resolvable), and a payment-ops queue with real states.
4) CI now runs three DB-free suites — it previously ran none, and the
   aggregate npm test hangs at entry 3 (fixed separately).

NO gateway code: the HPP client, poll/webhook, deposit PreAuth, refund and the
settled-vs-void branch are all still blocked on the iPOS rep confirming Void
and Refund are enabled at the TPN level.

Pipeline: Innovation + QA SHIP.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG. Push with: git push origin $BRANCH --tags"
