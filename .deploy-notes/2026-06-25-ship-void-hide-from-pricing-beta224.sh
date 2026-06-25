#!/usr/bin/env bash
# v0.9.0-beta.224 — FIX display: un cargo void-eado seguía apareciendo en la lista de charges.
#   bash .deploy-notes/2026-06-25-ship-void-hide-from-pricing-beta224.sh
#
# Backend-only, SIN migración. Sigue a beta.223. ⚠️ money-adjacent (display de pricing) — Hector revisa.
#
# SÍNTOMA (RES-513704, tras beta.223): el void bajó el unpaid balance a 0 ✅ pero el cargo
# void-eado SEGUÍA apareciendo en "Current charges".
# CAUSA: getPricing devolvía row.charges SIN filtrar selected, así que el ReservationCharge
# void-eado (selected=false) aún salía en el breakdown (y en los totals del pricing).
# FIX: getPricing ahora filtra los charges con selected===false (y sus totals). El row queda en
# la DB (selected=false) para historial + AuditLog. Aplica a TODOS los displays que leen
# pricing.charges (no solo el panel).
#
# CAMBIO:
#   backend/src/modules/reservations/reservation-pricing.service.js  (getPricing → filter selected!==false)
#
# Verificado local: node --check ✅.
#
# ── SMOKE (RES-513704) ──
#   Tras deploy + refresh: el CDW void-eado YA NO aparece en "Current charges", el balance sigue 0,
#   y el AuditLog del void permanece. Un cargo normal (selected:true) sigue mostrándose.
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout v0.9.0-beta.224
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/src/modules/reservations/reservation-pricing.service.js
#   .deploy-notes/2026-06-25-ship-void-hide-from-pricing-beta224.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.224"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservation-pricing.service.js"
  ".deploy-notes/2026-06-25-ship-void-hide-from-pricing-beta224.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: node --check service" >&2; exit 1; }
grep -q "filter((c) => c?.selected !== false)" backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: falta el filtro de void en getPricing" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reservations): hide voided charges from the pricing breakdown

After beta.223 a voided charge correctly dropped the balance but still showed in 'Current
charges': getPricing returned row.charges unfiltered, so the selected=false ReservationCharge
remained in the breakdown (and its totals). getPricing now filters selected!==false, so a voided
charge disappears from every display that reads pricing.charges, matching the recomputed balance.
The row stays in the DB (selected=false) for history + AuditLog. Backend-only, no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → force-recreate backend+worker → refresh RES-513704."
