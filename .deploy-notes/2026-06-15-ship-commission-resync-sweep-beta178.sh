#!/usr/bin/env bash
# v0.9.0-beta.178 — COMMISSION SNAPSHOT SELF-HEAL SWEEP (worker, code-only)
#   bash .deploy-notes/2026-06-15-ship-commission-resync-sweep-beta178.sh
#
# Sin migración. Sin código de dinero (NO cobra/mueve nada). El sweep solo
# RE-CALCULA snapshots de comisión (AgreementCommission) que ya escribe el
# checkout normal — misma función de prod, idempotente, PRESERVA PAID/APPROVED.
#
# POR QUÉ: el audit del 2026-06-15 encontró que TODOS los snapshots de comisión
# de reservas CHECKED_OUT/CHECKED_IN estaban congelados en $0 — se escribieron
# antes de que existiera la lógica del SERVICE_CATALOG y nada los recalculó.
# El backfill (src/scripts/backfill-commission-snapshots.js) arregló los datos
# viejos; ESTE sweep es el cinturón-y-tirantes para que no vuelva a pasar en
# NINGÚN tenant ni empleado: cada COMMISSION_RESYNC_SWEEP_MS (default 24h)
# re-corre syncAgreementCommissionSnapshot sobre todo agreement con inspección
# de CHECKOUT, en batches, y WARN si reparó algún drift.
#
# QUÉ ENTRA:
#   backend/src/modules/commissions/commission-resync.poll.js  (NUEVO sweep)
#   backend/src/worker.js  (start/stop del sweep — import top-level, va en FILES)
#
# DESPLIEGUE: backend + worker (misma imagen). Rebuild + force-recreate. NO toca
# frontend, NO migración. COMMISSION_RESYNC_SWEEP_MS es OPCIONAL (default 24h) —
# NO se añade a .env.example a propósito (no es requerido; evita romper env-diff).
#
# FILES:
#   backend/src/modules/commissions/commission-resync.poll.js
#   backend/src/worker.js
#   .deploy-notes/2026-06-15-ship-commission-resync-sweep-beta178.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.178"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/commissions/commission-resync.poll.js"
  "backend/src/worker.js"
  ".deploy-notes/2026-06-15-ship-commission-resync-sweep-beta178.sh"
)

# ── SYNTAX GATES — worker.js incluido SIEMPRE (el nuevo poll es import top-level;
#    si falta del FILES[] el worker no bootea → MODULE_NOT_FOUND).
( cd backend \
  && node --check src/modules/commissions/commission-resync.poll.js \
  && node --check src/worker.js \
  && node --check src/main.js )
echo "node --check OK."

# ── GUARDS — el sweep está cableado (import + start + stop) en el worker.
grep -nq "commission-resync.poll.js" backend/src/worker.js || { echo "ABORT: sweep no importado en worker.js." >&2; exit 1; }
grep -nq "startCommissionResyncSweep()" backend/src/worker.js || { echo "ABORT: start no cableado." >&2; exit 1; }
grep -nq "stopCommissionResyncSweep()" backend/src/worker.js || { echo "ABORT: stop no cableado." >&2; exit 1; }
grep -nq "syncAgreementCommissionSnapshot" backend/src/modules/commissions/commission-resync.poll.js || { echo "ABORT: el poll no llama la función real." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(commissions): daily self-heal sweep for commission snapshots

Prod audit (2026-06-15) found every CHECKED_OUT/CHECKED_IN agreement's
commission snapshot frozen at \$0 — written before the SERVICE_CATALOG
commission logic existed and never recomputed. The one-time backfill fixed the
historical rows; this sweep prevents silent drift again for any tenant/employee.

- backend/src/modules/commissions/commission-resync.poll.js: every
  COMMISSION_RESYNC_SWEEP_MS (default 24h) re-runs syncAgreementCommissionSnapshot
  for every agreement with a CHECKOUT inspection, all tenants, in batches.
  Idempotent + preserves PAID/APPROVED (only refreshes \$ amounts). WARNs when a
  total changes (drift repaired → a checkout path missed the snapshot, or a
  commission config changed without a recompute).
- worker.js: start on boot (2min after) + stop on shutdown, same pattern as the
  vehicle-status drift sweep."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. En el droplet (backend + worker, SIN migración):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 3 containers healthy + boot limpio (sin MODULE_NOT_FOUND/TypeError)."
echo "  Log del worker debe mostrar: '[commission-resync] started'"
echo "  ~2min después: '[commission-resync] clean — no drift' (o 'repaired ...' si"
echo "  quedaba algo sin backfillear)."
