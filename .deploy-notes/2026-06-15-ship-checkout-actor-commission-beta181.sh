#!/usr/bin/env bash
# v0.9.0-beta.181 — CHECKOUT INSPECTION CAPTURA EL CLERK (fix de atribución de comisión)
#   bash .deploy-notes/2026-06-15-ship-checkout-actor-commission-beta181.sh
#
# Sin migración. No toca código de pagos. Arregla la ATRIBUCIÓN de comisión.
#
# BUG: el flujo de checkout móvil/tablet (mobile-inspection.service.js) creaba la
# inspección de CHECKOUT SIN actorUserId. Como syncAgreementCommissionSnapshot
# atribuye la comisión al actorUserId de esa inspección (y hace early-return si
# ninguna lo tiene), los checkouts hechos en tablet NO ganaban comisión. Medido
# en International: en junio 1–15, 45 de 56 rentas de counter (RES) sin clerk →
# sin comisión. El empleado SÍ se conoce (token MOBILE_INSPECTION.createdByUserId
# y CheckoutSession.startedByUserId), solo no se estampaba.
#
# QUÉ ENTRA:
#   backend/src/modules/checkout-session/mobile-inspection.service.js
#     - ensureCheckoutInspection(agreementId, actorUserId): estampa el actor al
#       crear la inspección y lo rellena si una foto previa la creó sin actor.
#     - savePhoto: pasa row.createdByUserId (el empleado que generó el token).
#     - complete: estampa actorUserId (token.createdByUserId → session.startedByUserId)
#       en el update final de la inspección — el evento definitivo del checkout.
#   backend/scripts/backfill-checkout-actor.mjs  (NUEVO, no corre en deploy)
#     - rellena actorUserId en inspecciones CHECKOUT viejas SIN actor desde
#       CheckoutSession.startedByUserId. Dry-run por defecto; --apply para escribir.
#
# DESPLIEGUE: backend + worker (misma imagen). Rebuild + force-recreate. NO frontend,
# NO migración.
#
# FILES:
#   backend/src/modules/checkout-session/mobile-inspection.service.js
#   backend/scripts/backfill-checkout-actor.mjs
#   .deploy-notes/2026-06-15-ship-checkout-actor-commission-beta181.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.181"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/checkout-session/mobile-inspection.service.js"
  "backend/scripts/backfill-checkout-actor.mjs"
  ".deploy-notes/2026-06-15-ship-checkout-actor-commission-beta181.sh"
)

# ── SYNTAX GATES (main.js/worker.js incluidos por seguridad de import path).
( cd backend \
  && node --check src/modules/checkout-session/mobile-inspection.service.js \
  && node --check scripts/backfill-checkout-actor.mjs \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."

# ── GUARDS — el actor se estampa en los tres puntos del flujo móvil.
grep -nq "ensureCheckoutInspection(ag.id, row.createdByUserId" backend/src/modules/checkout-session/mobile-inspection.service.js || { echo "ABORT: savePhoto no pasa el actor." >&2; exit 1; }
grep -nq "actorUserId: actorUserId || null" backend/src/modules/checkout-session/mobile-inspection.service.js || { echo "ABORT: create no estampa actor." >&2; exit 1; }
grep -nq "row.createdByUserId || session.startedByUserId" backend/src/modules/checkout-session/mobile-inspection.service.js || { echo "ABORT: complete no estampa actor." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(commissions): capture checkout clerk on mobile inspection

The mobile/tablet checkout flow created the CHECKOUT inspection without an
actorUserId, so syncAgreementCommissionSnapshot (which attributes commission to
that actor and early-returns when none exists) skipped every tablet checkout —
counter rentals earned \$0 commission. Measured on International: 45/56 June
counter checkouts had no clerk.

- ensureCheckoutInspection stamps the actor on create and backfills it if a
  prior photo save created the row without one
- savePhoto passes the token's createdByUserId (the staff user who minted it)
- complete stamps actorUserId (token.createdByUserId → session.startedByUserId)
  on the final inspection update
- scripts/backfill-checkout-actor.mjs recovers historical attribution from
  CheckoutSession.startedByUserId (dry-run default)"
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. En el droplet (backend + worker, SIN migración):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "POST-DEPLOY (recupera el histórico — DRY primero, revisa, luego APPLY):"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); node scripts/backfill-checkout-actor.mjs --dry'"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); node scripts/backfill-checkout-actor.mjs --apply'"
echo "  # luego recalcula comisión (o espera el sweep diario de beta.178):"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); node src/scripts/backfill-commission-snapshots.js'"
echo
echo "VERIFY: 3 containers healthy + boot limpio. Después del backfill, el reporte"
echo "  Commission & Sales Performance (This month) debe mostrar MUCHAS más de 22"
echo "  rentas de counter con su clerk y comisión."
