#!/usr/bin/env bash
# v0.9.0-beta.223 — FIX Admin Corrections: void/add que NO pegaban (rebote del recompute).
#   bash .deploy-notes/2026-06-25-ship-admin-corrections-void-source-beta223.sh
#
# Backend-only, SIN migración. ⚠️ TOCA BALANCE (money) — Hector revisa diff + smoke + deploy.
#
# SÍNTOMA (reportado en vivo): void de un cargo (ej. CDW/insurance) decía "Voided ..." pero el
# cargo y el balance NO cambiaban. Y "add charge/credit" tampoco aplicaba.
#
# CAUSA (mismo origen, delete+rebuild de syncAgreementCharges):
#   - Cargos de la reserva (daily, insurance/CDW, mandatory, tolls, taxes) son ReservationCharge.
#     syncAgreementCharges BORRA los RentalAgreementCharge no-fee-engine y los RE-CREA desde los
#     ReservationCharge(selected:true). Void-ear el RentalAgreementCharge → se regenera → rebota.
#   - addManualCharge creaba un RentalAgreementCharge source=ADMIN_CORRECTION, pero el mismo delete
#     (NOT FEE_ENGINE_) lo BORRABA en el recompute inmediato → "add doesn't add".
#
# FIX (Opción B, aprobada por Hector — void/list por el ESPACIO real del cargo):
#   reservation-pricing.service.js:
#   1. syncAgreementCharges: el delete ahora preserva FEE_ENGINE_* **y** ADMIN_CORRECTION (ambos
#      viven solo en el agreement, sin ReservationCharge de origen). → los manual charges sobreviven.
#   2. voidAgreementCharge: detecta el espacio por id — FEE_ENGINE_/ADMIN_CORRECTION → soft-void el
#      RentalAgreementCharge; si no, → soft-void el ReservationCharge subyacente (así el rebuild lo
#      excluye). AuditLog ADMIN_OVERRIDE ahora incluye `space`. Recompute via
#      syncAgreementCharges({allowClosed:true}) (fórmula del motor, cero math manual).
#   3. listAgreementCharges: lista ReservationCharge(selected) [scope:reservation] +
#      RentalAgreementCharge FEE_ENGINE_/ADMIN_CORRECTION(selected) [scope:agreement], cada uno con
#      su id REAL → el void apunta a la tabla correcta. (El panel pasa charge.id → SIN cambio frontend.)
#   4. syncMandatoryLocationFees: en el update branch, si el admin void-eó un MANDATORY_FEE
#      (selected=false), NO lo re-selecciona → el void de mandatory también pega.
#
# Verificado local: node --check ✅. Frontend NO cambia (AdminCorrectionsPanel ya pasa charge.id).
# Nota: taxes son rows ReservationCharge propias; void-ear el principal baja el subtotal pero el row
# de TAX (si existe aparte) queda — se puede void-ear por separado (ahora aparece en la lista).
#
# ── SMOKE (Hector, en la reserva del CDW — TL-...) ──
#   1. Abre la reserva → Admin Corrections. Lista debe mostrar los cargos (Daily, CDW, etc.).
#   2. Void al "Insurance: Collision Damage Waiver (CDW)" $32.99 + razón → el cargo DESAPARECE y
#      el balance baja EXACTO $32.99 (de 32.99 → 0.00). Refresca: sigue void-eado (no rebota).
#   3. Add credit -25 → balance baja 25; Add charge 15 → sube 15. Refresca: persisten.
#   4. (si aplica) Void de un fee del fee-engine y de un mandatory → ambos pegan y no rebotan.
#   5. (DB) AuditLog: action=ADMIN_OVERRIDE con metadata.space + balanceBefore/After correctos.
#
# DEPLOY (BACKEND only, sin migración):
#   git fetch --tags && git checkout v0.9.0-beta.223
#   docker compose -f docker-compose.prod.yml build backend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#
# FILES:
#   backend/src/modules/reservations/reservation-pricing.service.js
#   .deploy-notes/2026-06-25-ship-admin-corrections-void-source-beta223.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.223"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservation-pricing.service.js"
  ".deploy-notes/2026-06-25-ship-admin-corrections-void-source-beta223.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: node --check service" >&2; exit 1; }
grep -q "NOT: { source: 'ADMIN_CORRECTION' }" backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: el delete no preserva ADMIN_CORRECTION" >&2; exit 1; }
grep -q "space: 'reservation'" backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: falta el ruteo por espacio en void" >&2; exit 1; }
grep -q "scope: 'reservation'" backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: listAgreementCharges no marca scope" >&2; exit 1; }
grep -q "existing.selected === false ? { ...data, selected: false } : data" backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: falta el guard de mandatory void" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reservations): Admin Corrections void/add now stick (void at source)

void/add appeared to succeed but didn't change the balance. Root cause is syncAgreementCharges'
delete+rebuild: it wipes all non-FEE_ENGINE_ RentalAgreementCharge rows and rebuilds them from
the reservation's ReservationCharge rows. So (a) soft-voiding a reservation-sourced agreement row
(CDW/insurance, daily, mandatory) was regenerated -> rebound, and (b) a manual ADMIN_CORRECTION
charge was deleted by the very recompute addManualCharge triggers -> 'add doesn't add'.

Option B fix (reservation-pricing.service.js): (1) the delete now also preserves ADMIN_CORRECTION
rows; (2) voidAgreementCharge detects the charge's space by id and soft-voids the ReservationCharge
for reservation-sourced charges (so the rebuild excludes it) or the RentalAgreementCharge for
fee-engine/admin rows; (3) listAgreementCharges returns both spaces with real ids + a scope flag;
(4) syncMandatoryLocationFees no longer re-selects an admin-voided mandatory fee. Recompute still
via syncAgreementCharges (engine formula) + AuditLog ADMIN_OVERRIDE (now with space). Frontend
unchanged (panel passes charge.id). Backend-only, no migration."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND → force-recreate backend+worker. SMOKE en la reserva del CDW antes de confiar."
