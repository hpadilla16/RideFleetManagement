#!/usr/bin/env bash
# Fix DISPLAY-ONLY: mostrar los cargos agreement-only (ADMIN_CORRECTION misc + DAMAGE_CHARGE)
# como line items read-only en la reserva. Frontend-only, sin backend, sin migración, sin dinero.
#   bash .deploy-notes/2026-07-10-ship-misc-charge-display.sh
#
# BUG (Hector, 2026-07-10): al añadir un misc charge, el balance del agreement se movía bien
# (persistido) PERO el line item no aparecía en el charges box ni en el panel de fees — solo en
# la lista propia del panel Admin Corrections. Causa: el misc/damage charge es un
# RentalAgreementCharge (source ADMIN_CORRECTION/DAMAGE_CHARGE), agreement-only; el charges box
# lee solo ReservationCharge; el panel "Post-Check-in Fees" filtraba solo FEE_ENGINE_*.
#
# FIX: el panel (retitulado "Post-Check-in Fees & Adjustments", debajo del charges box) ahora
# también muestra ADMIN_CORRECTION (tag MISC / ADJUSTMENT) y DAMAGE_CHARGE (tag DAMAGE), read-only,
# excluyendo los voided (selected:false). SIN doble conteo: Unpaid Balance sigue leyendo
# agreementFull.balance (ya los incluye una vez); ningún total suma el misc encima. El agreement
# se auto-refresca (bypassCache) tras la corrección. Un PDF ya impreso es snapshot → reimprimir.
#
# DEPLOY (FRONTEND-only; backend/worker sin cambio pero rebuild de los 3 es seguro):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate frontend
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.291}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "frontend/src/app/reservations/[id]/page.js"
  ".deploy-notes/2026-07-10-ship-misc-charge-display.sh"
)

# ── SANITY GATES ──
grep -q 'ADMIN_CORRECTION' "frontend/src/app/reservations/[id]/page.js" || { echo "ABORT: el fix no está en page.js" >&2; exit 1; }
grep -q 'DAMAGE_CHARGE' "frontend/src/app/reservations/[id]/page.js" || { echo "ABORT: falta DAMAGE_CHARGE en el filtro" >&2; exit 1; }
echo "Guards OK (frontend-only; sin backend/migración/dinero)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reservations): show agreement-only misc/damage charges as read-only line items

The misc charge (Admin Corrections) and damage charge are RentalAgreementCharge rows
(source ADMIN_CORRECTION / DAMAGE_CHARGE), agreement-only — the reservation charges box
reads only ReservationCharge, so the line item never appeared even though the agreement
balance moved correctly. Broaden the 'Post-Check-in Fees' panel (retitled 'Post-Check-in
Fees & Adjustments', below the charges box) to also render ADMIN_CORRECTION (tag MISC /
ADJUSTMENT) and DAMAGE_CHARGE (tag DAMAGE), read-only, excluding voided rows. Display-only:
Unpaid Balance still reads agreementFull.balance (already includes the charge once); no
displayed total double-counts. Agreement self-refreshes via bypassCache after the correction."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build frontend -> recreate frontend."
