#!/usr/bin/env bash
# v0.9.0-beta.188 — Fase D (MONEY): facturar la multa al renter (auto, solo balance)
#   bash .deploy-notes/2026-06-15-ship-citation-billing-beta188.sh
#
# *** CÓDIGO DE DINERO *** — regla del repo: revisar el DIFF completo antes de confirmar.
#   El script hace `git add` y luego muestra el diff staged; LÉELO antes de responder y.
#
# BACKEND-ONLY, sin migración.
#
# QUE HACE:
#   - fee-engine: nuevo feeType CITATION_ADMIN (default $35, configurable por tenant
#     en Settings → Fee Rates, igual que los demás fees).
#   - citations.service.syncCitationCharges(reservationId): idempotente. Por cada
#     citation MATCHED a esa reserva crea/actualiza un reservationCharge source
#     CITATION_MODULE (la multa) + uno CITATION_ADMIN (el fee, si está activo),
#     poda los stale, marca billingStatus=POSTED_TO_AGREEMENT, y recomputa el
#     pricing con getPricing({allowClosed:true}) → mirror al agreement + balance.
#     Mismo patrón seguro que issue-center createChargeDraft. NO cobra tarjeta:
#     solo deja el saldo en el balance (el cobro se hace en el contrato).
#   - Auto-post: se llama al matchear en ingestBatch (multas que caen en una renta)
#     y en review() (CONFIRM postea; VOID/DISPUTE/REJECT recomputan y quitan).
#
# Deploy: build backend + worker + force-recreate. Verificar 3 healthy + boot limpio.
#   Smoke: una citation MATCHED a una reserva → su multa + admin fee aparecen en el
#   balance del agreement; al hacer Void/Undo, se quitan.
#
# FILES:
#   backend/src/modules/fees/fee-engine.service.js
#   backend/src/modules/citations/citations.service.js
#   .deploy-notes/2026-06-15-ship-citation-billing-beta188.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.188"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/fees/fee-engine.service.js"
  "backend/src/modules/citations/citations.service.js"
  ".deploy-notes/2026-06-15-ship-citation-billing-beta188.sh"
)

# ── GATES
node --check backend/src/modules/fees/fee-engine.service.js
node --check backend/src/modules/citations/citations.service.js
grep -nq "CITATION_ADMIN" backend/src/modules/fees/fee-engine.service.js || { echo "ABORT: CITATION_ADMIN falta en fee-engine." >&2; exit 1; }
grep -nq "async function syncCitationCharges" backend/src/modules/citations/citations.service.js || { echo "ABORT: syncCitationCharges falta." >&2; exit 1; }
grep -nq "allowClosed: true" backend/src/modules/citations/citations.service.js || { echo "ABORT: recompute allowClosed falta." >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo
echo "===== DINERO: revisa este diff antes de confirmar ====="; git --no-pager diff --cached -- backend/ | sed -n '1,200p'; echo "===== (fin del preview) ====="; echo
git status --short -- "${FILES[@]}"; echo
read -r -p "MONEY CODE — Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): Fase D — auto-bill matched citations to the renter agreement (balance-only)

Add CITATION_ADMIN fee (default \$35, tenant-configurable) and syncCitationCharges:
for each citation MATCHED to a reservation, post a CITATION_MODULE charge (the fine)
+ CITATION_ADMIN charge, prune stale, then recompute pricing with allowClosed so it
mirrors into the (often closed) agreement and updates the unpaid balance. Auto-posts
on ingest match and on review (CONFIRM posts; VOID/DISPUTE/REJECT remove). Never
charges a card — balance only; collection happens in the contract flow."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Build backend+worker, force-recreate, verify health + a smoke on one matched citation."
