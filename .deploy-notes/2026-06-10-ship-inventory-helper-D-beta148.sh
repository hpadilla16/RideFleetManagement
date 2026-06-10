#!/usr/bin/env bash
# v0.9.0-beta.148 — Inventory Helper, Phase D (reconciliation dashboard + auto-resolve).
#   bash .deploy-notes/2026-06-10-ship-inventory-helper-D-beta148.sh
#
# CODE-ONLY — NO migration (FleetReconciliationFlag already shipped in beta.145).
# No money code. Stacks on beta.147 (release/deposit-balance-fix-beta119).
#
# WHAT: deferred inventory mismatches ("resolve with note") now surface on the
# dashboard as a "Status Mismatches" tile (replaces Wash Holds), linking to a
# reconciliation list (/vehicles/reconciliation) where each can be checked in or
# marked resolved. Flags auto-resolve when their condition clears — lazily on
# list load, and hourly via the worker's vehicle-status sweep. The reconciliation
# re-evaluator is puppeteer-free, so the worker stays light.
#
# FILES:
#   backend/src/modules/inventory/inventory-reconciliation.js   reEvaluateOpenFlags (auto-resolve)
#   backend/src/modules/inventory/inventory.service.js          listOpenReconciliation / resolveReconciliationFlag
#   backend/src/modules/inventory/inventory.routes.js           GET /reconciliation/open, POST /reconciliation/:id/resolve
#   backend/src/modules/vehicles/vehicle-status-sweep.poll.js   hourly auto-resolve hook (worker)
#   frontend/src/app/page.js                                    dashboard "Status Mismatches" tile (replaces Wash Holds)
#   frontend/src/app/vehicles/reconciliation/page.js            reconciliation list
#   .deploy-notes/2026-06-10-ship-inventory-helper-D-beta148.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.148"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/inventory/inventory-reconciliation.js"
  "backend/src/modules/inventory/inventory.service.js"
  "backend/src/modules/inventory/inventory.routes.js"
  "backend/src/modules/vehicles/vehicle-status-sweep.poll.js"
  "frontend/src/app/page.js"
  "frontend/src/app/vehicles/reconciliation/page.js"
  ".deploy-notes/2026-06-10-ship-inventory-helper-D-beta148.sh"
)

# ── SYNTAX GATE. Includes worker.js — the sweep poll (which now imports the
#    reconciliation module) runs in the worker, so a missing file = worker crash.
( cd backend \
  && node --check src/modules/inventory/inventory-reconciliation.js \
  && node --check src/modules/inventory/inventory.service.js \
  && node --check src/modules/inventory/inventory.routes.js \
  && node --check src/modules/vehicles/vehicle-status-sweep.poll.js \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."

( cd backend && node --test src/modules/inventory/inventory-logic.test.mjs >/dev/null ) && echo "inventory unit tests OK."

# ── GUARDS.
grep -nq "reEvaluateOpenFlags" backend/src/modules/inventory/inventory-reconciliation.js || { echo "ABORT: reEvaluateOpenFlags missing." >&2; exit 1; }
grep -nq "reEvaluateOpenFlags" backend/src/modules/vehicles/vehicle-status-sweep.poll.js || { echo "ABORT: sweep not wired to reconciliation." >&2; exit 1; }
grep -nq "reconciliation/open" backend/src/modules/inventory/inventory.routes.js || { echo "ABORT: reconciliation route missing." >&2; exit 1; }
grep -nq "Status Mismatches" frontend/src/app/page.js || { echo "ABORT: dashboard tile missing." >&2; exit 1; }
[ -f frontend/src/app/vehicles/reconciliation/page.js ] || { echo "ABORT: reconciliation page missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(inventory): Phase D — reconciliation dashboard tile + auto-resolution

Deferred inventory mismatches surface as a dashboard 'Status Mismatches' tile
(replaces Wash Holds) → /vehicles/reconciliation list (check-in or mark
resolved). Flags auto-resolve when their condition clears: lazily on list load
and hourly via the worker's vehicle-status sweep (puppeteer-free re-evaluator).
Code-only, no migration."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet (CODE-ONLY — no migration):"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "VERIFY: 4 containers healthy (incl. worker) + clean boot + /health 200 + HARD refresh."
echo "  smoke: resolve a mismatch 'with note' in the wizard → dashboard 'Status Mismatches'"
echo "         count rises → click → reconciliation list → check-in or Mark resolved → count drops."
