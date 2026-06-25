#!/usr/bin/env bash
# v0.9.0-beta.219 — Fix: el Unpaid Balance del detalle de reserva quedaba STALE tras una mutación
# de pricing (Save Override / extensión / delete extension) hasta un reload completo de la página.
#   bash .deploy-notes/2026-06-24-ship-unpaid-balance-refresh-beta219.sh
#
# FRONTEND-only, SIN migración. NO toca lógica de dinero del backend (solo el re-fetch del UI).
#
# BUG (reportado en TL-ZE40802254BA): tras extender una reserva + Edit/Save Override, los días y
# los cargos se actualizaban pero el "Unpaid Balance" NO — había que dar refresh manual a la
# página para que cambiara (ej. 220 → 267.11). Causa: `refresh()` (la recarga ligera que se llama
# tras CADA acción) re-fetcheaba reservation + pricing + payments pero NO `agreementFull`
# (`GET /api/rental-agreements/:id`), y el Unpaid Balance se lee de `agreementFull.balance`
# (RentalAgreement.balance = fuente de verdad, recomputada server-side en cada mutación). Solo el
# `load()` completo (reload de página) re-fetcheaba el agreement.
#
# FIX: `refresh()` ahora también re-fetchea el agreement → el balance recompute aparece al instante
# tras Save Override / extensión, sin reload manual. (Es +1 request por acción, sigue más liviano
# que `load()`.)
#
# Verificado local: esbuild parse del page.js ✅.
#
# DEPLOY (FRONTEND ONLY):
#   git fetch --tags && git checkout v0.9.0-beta.219
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
#   # Hard refresh tras el deploy.
#
# SMOKE: abre una reserva → extiéndela (o Edit pricing → Save Override) → el Unpaid Balance debe
#   actualizarse SOLO, sin tener que refrescar la página.
#
# NOTA (follow-up aparte, NO en este ship): el "se quedó en 7 días en vez de 8" tras la extensión
#   parece un off-by-one/timing en el flujo de extend; necesita un repro para cazarlo. Este fix
#   cubre el síntoma del balance stale, que era el dolor recurrente.
#
# FILES:
#   frontend/src/app/reservations/[id]/page.js
#   .deploy-notes/2026-06-24-ship-unpaid-balance-refresh-beta219.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.219"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/reservations/[id]/page.js"
  ".deploy-notes/2026-06-24-ship-unpaid-balance-refresh-beta219.sh"
)

# ── SANITY GATES ──
grep -q "Re-fetch the agreement too" "frontend/src/app/reservations/[id]/page.js" || { echo "ABORT: fix no presente" >&2; exit 1; }
grep -q "setAgreementFull(ag" "frontend/src/app/reservations/[id]/page.js" || { echo "ABORT: refresh no setea agreementFull" >&2; exit 1; }
node -e "const s=require('fs').readFileSync('frontend/src/app/reservations/[id]/page.js','utf8'); const b=(s.match(/{/g)||[]).length-(s.match(/}/g)||[]).length,p=(s.match(/\(/g)||[]).length-(s.match(/\)/g)||[]).length; if(b||p){console.error('unbalanced',b,p);process.exit(1)}" || { echo "ABORT: desbalanceado" >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reservations): refresh() re-fetches the agreement so Unpaid Balance updates live

The reservation detail's light refresh() (run after every action) re-fetched reservation +
pricing + payments but NOT the rental agreement, and the Unpaid Balance reads
RentalAgreement.balance (the server-recomputed source of truth). So after Save Override /
extension the balance stayed stale until a full page reload (seen on TL-ZE40802254BA: 220 vs
267.11). refresh() now also re-fetches /api/rental-agreements/:id and updates agreementFull.
Frontend-only; no migration; no charge logic."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build FRONTEND → force-recreate. Hard refresh."
