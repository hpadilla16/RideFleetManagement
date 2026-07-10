#!/usr/bin/env bash
# Fix MONEY: start-rental (Print Agreement) ya NO borra los cargos agreement-only.
#   bash .deploy-notes/2026-07-10-ship-agreement-charge-preserve.sh
#
# BUG (Hector, 2026-07-10): al añadir un misc charge (ADMIN_CORRECTION) o damage charge
# (DAMAGE_CHARGE) y luego darle Print Agreement en una renta CHECKED_OUT, el cargo desaparecía
# del agreement, el balance se revertía, y no se podía void. Causa: startFromReservation
# (rental-agreements.service.js) hacía un deleteMany INCONDICIONAL de todos los RentalAgreementCharge
# y recreaba solo desde ReservationCharge → borraba los agreement-only (misc/damage) y revertía
# total/balance. Al borrarse la fila, el void tampoco encontraba el chargeId. Es el mismo bug que
# syncAgreementCharges ya tenía parchado con el carve-out; startFromReservation nunca lo recibió.
#
# FIX (mismo carve-out que syncAgreementCharges): los dos deleteMany de startFromReservation
# (~:2188 y ~:2285) ahora PRESERVAN source FEE_ENGINE_*/ADMIN_CORRECTION/DAMAGE_CHARGE, y el
# recompute de totales se delega a reservationPricingService.syncAgreementCharges (el reconciler
# canónico, expuesto como método público). Resultado: el cargo sobrevive el Print, sale en el
# agreement, se mantiene voidable, y el balance lo cuenta UNA sola vez. Tax-proration/§6 intactos;
# addManualCharge y voidAgreementCharge sin tocar. (El 3er deleteMany ~:2413 —bootstrap de cargos
# sintéticos cuando la reserva no tiene charges— se deja igual a propósito: delegar ahí borraría
# las líneas diarias/tax.) Afecta también el flujo Admin Corrections existente (bug pre-existente).
#
# PIPELINE: root-cause + fix + QA SHIP. Test nuevo DB-backed prueba que el cargo sobrevive
# start-rental, sigue voidable, y el balance lo incluye una vez (no revertido, no doblado).
#
# SIN migración. DEPLOY (BACKEND + WORKER; frontend sin cambio pero rebuild seguro):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.292}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/rental-agreements/rental-agreements.service.js"
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/rental-agreements/start-from-reservation-preserves-manual-charges.test.mjs"
  "backend/package.json"
  ".deploy-notes/2026-07-10-ship-agreement-charge-preserve.sh"
)

# ── SANITY GATES ──  (tests DB-backed → validados en QA; gate local sin DB)
node --check backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: node --check rental-agreements" >&2; exit 1; }
node --check backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: node --check reservation-pricing" >&2; exit 1; }
# el carve-out está presente en el sync de start-rental
grep -q "ADMIN_CORRECTION" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: falta el carve-out ADMIN_CORRECTION en rental-agreements" >&2; exit 1; }
grep -q "DAMAGE_CHARGE" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: falta DAMAGE_CHARGE en el carve-out" >&2; exit 1; }
# syncAgreementCharges expuesto y usado por rental-agreements
grep -q "syncAgreementCharges" backend/src/modules/rental-agreements/rental-agreements.service.js || { echo "ABORT: rental-agreements no delega a syncAgreementCharges" >&2; exit 1; }
grep -q "start-from-reservation-preserves-manual-charges" backend/package.json || { echo "ABORT: el test nuevo no está en package.json" >&2; exit 1; }
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK (test start-rental preserva-cargos validado en QA)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(agreements): start-rental preserves agreement-only misc/damage charges (MONEY)

Print/Email Agreement on a CHECKED_OUT rental fired start-rental, whose re-sync did an
unconditional deleteMany of ALL RentalAgreementCharge rows and recreated only the
reservation-derived ones — deleting the agreement-only ADMIN_CORRECTION (misc) and
DAMAGE_CHARGE rows and reverting total/balance, and (because the row was gone) making the
void fail. Mirror the syncAgreementCharges carve-out in startFromReservation's two deleteMany
paths (preserve FEE_ENGINE_* / ADMIN_CORRECTION / DAMAGE_CHARGE) and delegate the totals
recompute to the canonical reservationPricingService.syncAgreementCharges. The charge now
survives Print, renders on the agreement, stays voidable, and is counted exactly once; the
synthesized-charges bootstrap deleteMany is intentionally left as-is. addManualCharge and
voidAgreementCharge unchanged; tax-proration/incident §6 intact. New DB-backed test asserts
survival + voidability + single-count. QA: SHIP. No migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend worker frontend -> recreate."
