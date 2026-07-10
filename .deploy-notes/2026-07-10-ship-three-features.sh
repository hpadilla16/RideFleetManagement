#!/usr/bin/env bash
# 3 features (backend + frontend). NO ship-dark — van en vivo al desplegar.
#   bash .deploy-notes/2026-07-10-ship-three-features.sh
#
# F1 — Admins pueden override el status de la reserva (antes solo SUPER_ADMIN).
#      main.js: /api/admin/reservations pasa a requireRole('ADMIN','SUPER_ADMIN').
#      Mismo poder que super admin (todos los status + smart rewind). Audit ADMIN_OVERRIDE ya existía.
# F2 — Misc charge: re-label del panel Admin Corrections ("Add charge / misc item" para
#      damages/tickets de valor variable). SOLO label — la mecánica de dinero (addManualCharge,
#      source ADMIN_CORRECTION, taxable:false, recompute) NO cambia. Admin-only (canDoAdminCorrections).
# F3 — Botón "Report Damage" en la reserva (AGENT/OPS/ADMIN/SUPER_ADMIN): wizard que orquesta
#      3 módulos existentes — registra el daño HARD_APPROVED en el vehicle profile, sube fotos +
#      estimado, pregunta quién paga (cliente/seguro cliente → costo al contrato; seguro nuestro →
#      solo el deducible al contrato), pone el status del carro, y auto-crea el Incident Report en
#      DRAFT + nudge "Complete now". Failsafe admin: editar/borrar el damage (delete → void del cargo).
#
# DINERO (revisado línea-a-línea por Hector): el DAMAGE_CHARGE se escribe UNA sola vez vía
# addManualCharge→syncAgreementCharges (sin gateway/tarjeta). Techo configurable $10k antes de
# escribir (key tenant:<id>:damageChargeMaxAmount). Idempotencia (Idempotency-Key + guard 60s).
# Edit re-sync (void+re-add). Delete → void. Carve-out DAMAGE_CHARGE en el recompute. Callers
# viejos de addManualCharge byte-idénticos (source default ADMIN_CORRECTION, returnMeta default false).
# ACCESS: el agente cobra SOLO por el flujo report-damage; la ruta general /charges sigue admin-only
# y no reenvía source. F1 override = ADMIN+SUPER_ADMIN con audit.
#
# PIPELINE: Innovation + Graphic Design + QA (SHIP). 4 must-change resueltos
# (orphan-charge, our-insurance ambos montos, §6 "ya en el contrato", + techo/idempotencia/re-sync).
# 2 MINORs aceptados (guard 60s mismo-monto; orden del re-sync) — ambos fail-safe.
#
# CON MIGRACIÓN (aditiva, idempotente, boot-applied):
#   20260710_report_damage — 6 columnas nullable en VehicleDamageReport (reservationChargeId,
#     incidentId, estimatePhotoJson, damageCostCents, ourDeductibleCents, responsibleParty).
#     Null para todos los registros/callers existentes → cero cambio al flujo de daños actual.
#
# ── SMOKE ──
#   cd backend && npm run test:report-damage      # 11 verdes
#   npm run test:reservation-override             # 6 verdes
#   Prod: en una reserva, botón "Report Damage" → wizard → confirmar cargo único en el contrato,
#     hard-approval en el vehicle profile, status del carro, e Incident Report en DRAFT.
#     Admin: probar Edit/Delete del damage (delete revierte el cargo).
#
# DEPLOY (BACKEND + WORKER + FRONTEND, CON migración auto al boot):
#   git fetch --tags && git checkout <TAG>   (limpia untracked si estorban)
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   ⚠️ incluir `worker` en el build (imagen propia).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.290}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/main.js"
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/customer-inspection/customer-inspection.service.js"
  "backend/src/modules/report-damage/report-damage.service.js"
  "backend/src/modules/report-damage/report-damage.routes.js"
  "backend/src/modules/report-damage/report-damage.test.mjs"
  "backend/src/modules/admin/reservation-override.test.mjs"
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260710_report_damage/migration.sql"
  "backend/package.json"
  "frontend/src/app/reservations/[id]/page.js"
  "frontend/src/app/vehicles/[id]/page.js"
  "frontend/src/components/admin/ReservationOverridePanel.jsx"
  "frontend/src/components/incident/IncidentReportsPanel.jsx"
  "frontend/src/components/reservations/ReportDamageWizard.jsx"
  "doc/three-features-plan-2026-07-10.md"
  ".deploy-notes/2026-07-10-ship-three-features.sh"
)

# ── SANITY GATES ──
for f in \
  backend/src/main.js \
  backend/src/modules/reservations/reservation-pricing.service.js \
  backend/src/modules/customer-inspection/customer-inspection.service.js \
  backend/src/modules/report-damage/report-damage.service.js \
  backend/src/modules/report-damage/report-damage.routes.js ; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
# F1 gate widened correctamente
grep -q "requireRole('ADMIN', 'SUPER_ADMIN'), reservationOverrideRouter" backend/src/main.js \
  || grep -q "requireRole('ADMIN','SUPER_ADMIN'), reservationOverrideRouter" backend/src/main.js \
  || { echo "ABORT: F1 gate no está en ADMIN+SUPER_ADMIN" >&2; exit 1; }
# F3 montado
grep -q 'reportDamageRouter' backend/src/main.js || { echo "ABORT: main.js no monta report-damage" >&2; exit 1; }
# addManualCharge source default sigue ADMIN_CORRECTION (callers viejos intactos)
grep -q "ADMIN_CORRECTION" backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: falta el default source ADMIN_CORRECTION" >&2; exit 1; }
# migración aditiva idempotente
test -f backend/prisma/migrations/20260710_report_damage/migration.sql || { echo "ABORT: falta la migración report_damage" >&2; exit 1; }
grep -qi 'IF NOT EXISTS' backend/prisma/migrations/20260710_report_damage/migration.sql || { echo "ABORT: la migración report_damage no es idempotente" >&2; exit 1; }
# NOTA: test:report-damage y test:reservation-override son DB-backed (siembran vía Prisma
# contra localhost:5433) — NO corren en el Mac sin un Postgres local. Ya fueron validados en
# QA contra embedded-postgres (report-damage 11/11, reservation-override 6/6). El gate del Mac
# se queda en checks que NO necesitan DB: node --check + prisma validate + greps de invariantes.
# Si quieres correrlos localmente: levanta el Postgres de dev en :5433 y ejecuta
#   ( cd backend && npm run test:report-damage && npm run test:reservation-override )
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK (tests DB-backed validados en QA; gate local sin DB)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat: admin status-override + misc-charge relabel + Report Damage flow (3 features)

F1: widen reservation status override + smart rewind from SUPER_ADMIN-only to
ADMIN + SUPER_ADMIN (same power; ADMIN_OVERRIDE audit unchanged).
F2: re-label the admin-only Admin Corrections panel to 'Add charge / misc item'
for damage/ticket variable-value charges (label-only; money mechanics unchanged).
F3: 'Report Damage' wizard launched from a reservation (AGENT/OPS/ADMIN/SUPER_ADMIN)
that orchestrates the existing vehicle-damage, contract-charge and incident modules:
records a HARD_APPROVED VehicleDamageReport with photos + estimate, asks who-pays
(customer / customer insurance -> full cost to the contract; our insurance -> only
our deductible to the contract), sets the vehicle status, and auto-creates the
Incident Report as a DRAFT with a 'Complete now' nudge. Admin failsafe: edit/delete
the damage record (delete voids the linked charge).

Money: DAMAGE_CHARGE written exactly once via addManualCharge->syncAgreementCharges
(no gateway/card); configurable ceiling (default \$10k) checked before any write;
idempotency (Idempotency-Key + 60s guard); edit re-sync (void+re-add); delete voids;
recompute carve-out. Existing addManualCharge callers byte-identical (source default
ADMIN_CORRECTION, returnMeta default false). Access: agents bill only inside the
report-damage flow; the general charge route stays admin-only and doesn't forward
source. Reviewed line-by-line by Hector. Innovation + Graphic Design + QA: SHIP.
One additive idempotent migration (6 nullable cols on VehicleDamageReport; null for
existing records -> zero change to the current damage flow)."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend worker frontend -> recreate. Migración auto al boot."
