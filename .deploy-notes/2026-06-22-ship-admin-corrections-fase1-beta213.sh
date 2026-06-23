#!/usr/bin/env bash
# v0.9.0-beta.213 — Admin Corrections (Fase 1): void charge / add manual charge-credit.
#   bash .deploy-notes/2026-06-22-ship-admin-corrections-fase1-beta213.sh
#
# Backend + Frontend, SIN migración. ⚠️ TOCA BALANCE (money) — Hector revisa diff + smoke + deploy.
#
# QUÉ: herramienta nativa SOLO-ADMIN para arreglar errores de piso sin SQL (reemplaza el
# fix manual que hicimos hoy en RES-721750). Fase 1 de 3 (plan: doc/admin-corrections-plan-2026-06-22.md):
#   - Void de cualquier cargo del agreement, incl. los post-check-in fees del fee-engine
#     (fuel/cleaning/smoking/late). Soft-void: selected=false (queda en historial, sale de totales).
#   - Add manual charge / credit (monto negativo = crédito).
#
# SEGURIDAD (clave): NINGÚN cálculo de balance a mano. Cada mutación llama a
# syncAgreementCharges(reservationId, scope, { allowClosed:true }) — la MISMA fórmula del motor
# (fees=ΣFEE_ENGINE, total=subtotal+taxes+fees, balance=max(0,total−paid)) — y escribe un
# AuditLog(action=ADMIN_OVERRIDE) con actorUserId + reason (obligatoria) + balance before/after
# en metadata. Gate: requireRole ADMIN/SUPER_ADMIN (helper canDoAdminCorrections). No usa enum
# nuevo (ADMIN_OVERRIDE ya existe) → SIN migración.
#
# CAMBIOS:
#   backend/src/modules/reservations/reservation-pricing.service.js
#     + reservationPricingService.voidAgreementCharge(reservationId, chargeId, {reason,actorUserId}, scope)
#     + reservationPricingService.addManualCharge(reservationId, {name,amount}, {reason,actorUserId}, scope)
#   backend/src/modules/reservations/reservations.routes.js
#     + helper canDoAdminCorrections(req)
#     + POST /api/reservations/:id/charges/:chargeId/void   (ADMIN, reason requerida)
#     + POST /api/reservations/:id/charges                  (ADMIN, {name,amount,reason})
#   frontend/src/app/reservations/[id]/page.js
#     + <AdminCorrectionsPanel> (solo ADMIN/SUPER_ADMIN): botón "Void" por cargo + form "Add charge/credit";
#       tras cada cambio recarga el pricing y dispara el load() del padre.
#
# Verificado local: node --check de los 2 archivos backend ✅; esbuild parse del page.js ✅.
# El 'next build' del docker valida el JSX completo.
#
# ── SMOKE TEST (Hector, en una reserva de prueba con balance > 0) ──
#   1. Abre la reserva como ADMIN → panel "⚙️ Admin Corrections" → Show.
#   2. Void de un fee (ej. un fuel/smoking): pide razón → el balance baja EXACTO por el monto del fee,
#      el cargo desaparece de los totales, y queda una fila AuditLog(ADMIN_OVERRIDE, kind=void_charge).
#   3. Add credit: name="Goodwill", amount=-25 → balance baja $25; Add charge amount=15 → sube $15.
#   4. Verifica que NO-admin (OPS/staff) NO ve el panel y que las rutas dan 403.
#   5. (DB) AuditLog: SELECT action, reason, metadata FROM "AuditLog" WHERE "reservationId"=... ORDER BY "createdAt" DESC;
#      → metadata trae balanceBefore/balanceAfter correctos.
#
# DEPLOY (BACKEND + FRONTEND):
#   git fetch --tags && git checkout v0.9.0-beta.213
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend frontend
#   # Sin migración. Hard refresh tras deploy.
#
# FILES:
#   backend/src/modules/reservations/reservation-pricing.service.js
#   backend/src/modules/reservations/reservations.routes.js
#   frontend/src/app/reservations/[id]/page.js
#   doc/admin-corrections-plan-2026-06-22.md
#   .deploy-notes/2026-06-22-ship-admin-corrections-fase1-beta213.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.213"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reservations/reservation-pricing.service.js"
  "backend/src/modules/reservations/reservations.routes.js"
  "frontend/src/app/reservations/[id]/page.js"
  "doc/admin-corrections-plan-2026-06-22.md"
  ".deploy-notes/2026-06-22-ship-admin-corrections-fase1-beta213.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: node --check pricing service" >&2; exit 1; }
node --check backend/src/modules/reservations/reservations.routes.js          || { echo "ABORT: node --check routes" >&2; exit 1; }
grep -q "async voidAgreementCharge"  backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: falta voidAgreementCharge" >&2; exit 1; }
grep -q "async addManualCharge"      backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: falta addManualCharge" >&2; exit 1; }
grep -q "ADMIN_OVERRIDE"             backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: falta el AuditLog ADMIN_OVERRIDE" >&2; exit 1; }
grep -q "allowClosed: true"          backend/src/modules/reservations/reservation-pricing.service.js || { echo "ABORT: el recompute debe usar allowClosed" >&2; exit 1; }
grep -q "/:id/charges/:chargeId/void" backend/src/modules/reservations/reservations.routes.js || { echo "ABORT: falta la ruta void" >&2; exit 1; }
grep -q "canDoAdminCorrections"       backend/src/modules/reservations/reservations.routes.js || { echo "ABORT: falta el gate ADMIN" >&2; exit 1; }
grep -q "AdminCorrectionsPanel"       "frontend/src/app/reservations/[id]/page.js" || { echo "ABORT: falta el panel frontend" >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(reservations): Admin Corrections Fase 1 — void charge / add manual charge-credit

ADMIN-only tool to fix floor mistakes without SQL (replaces today's manual fix on
RES-721750). Void any agreement charge incl. post-check-in fee-engine fees (soft-void,
selected=false) or add a manual charge/credit. Every mutation recomputes the balance via
syncAgreementCharges({allowClosed:true}) — the engine's own formula, no manual math — and
writes an AuditLog(ADMIN_OVERRIDE) with actorUserId + required reason + before/after balance.
Routes POST /:id/charges/:chargeId/void and POST /:id/charges gated to ADMIN. Frontend
AdminCorrectionsPanel on the reservation detail. No migration; Fase 1 of 3 (see
doc/admin-corrections-plan-2026-06-22.md)."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND + FRONTEND → force-recreate ambos. Sin migración. SMOKE antes de confiar."
