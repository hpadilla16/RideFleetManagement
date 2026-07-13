#!/usr/bin/env bash
# MONEY-REPORTS AUDIT FIXES — el "Revenue in period" 7× inflado + toda su clase.
#   bash .deploy-notes/2026-07-13-ship-money-reports-audit-fixes-beta296.sh
#
# BUG PADRE (Hector, 2026-07-13): "Revenue in period" (reports-v2 landing) daba
# $336,113 para International jul 1-13 cuando lo cobrado real era $47,515 —
# getSnapshot sumaba RentalAgreementPayment sin status='PAID' y sin excluir
# method='AUTH_HOLD' (holds de depósito: fondos NUNCA capturados; $287,951 de
# la inflación eran 127 holds + 1 VOID de $646.69). Auditoría completa de los
# reportes (2 agentes + cuantificación contra prod) encontró la misma clase de
# bug en más lugares + otros. TODO son READ paths de reportes — CERO cambios a
# motores de pago/charges. SIN migración. Cambios solo de BACKEND (el comando
# de deploy rebuild-ea frontend también por convención — inocente: no hay
# commits de frontend sin shippear en la rama tras beta.295).
#
# FIXES (backend/src/modules/reports/):
# - collected-payments.js (NUEVO): COLLECTED_PAYMENT_WHERE — definición canónica
#   de "dinero cobrado" (PAID + sin AUTH_HOLD), compartida para que no diverja.
# - reports-v2.service.js: getSnapshot usa el filtro compartido ($336K→$47.5K,
#   validado contra prod) + logger.warn en vez de catch silencioso.
# - payments-by-day.report.js: sus exclusiones importan del módulo compartido.
# - commission-sales-performance + agent-track-record: "Paid at counter" ya no
#   cuenta holds/VOID (nested payments.where) + attach first-match-wins vía
#   resolveCatalogEntry ("Liability Insurance" comisionaba doble LIAB+INS).
# - sales + taxes: agreements CANCELLED/DRAFT fuera (decisión Hector: venta =
#   llegó al counter; un void deja charges selected=true para siempre). En
#   pareja, agregado + drill-downs.
# - toll-per-location + toll-per-vehicle: tolls VOID fuera (void es por status,
#   sin fila de crédito), agregado + drill-downs.
# - commission.report.js: drill-down de empleado con ventana tz-aware del
#   tenant (antes corría 1 día antes y no cuadraba con el reporte).
# - reports.service.js (overview legacy + email diario ops): "Collected
#   Payments" excluye AUTH_HOLD (ReservationPayment también espeja holds —
#   $288,601 de inflación en julio); projectedRevenue sin CANCELLED/NO_SHOW;
#   vehicleRevenue/inventoryReport sin TAX/DEPOSIT ni reservas canceladas.
# - Tests: money-report-filters.test.mjs (NUEVO, 5) + fakes extendidos +
#   test:reports ahora corre 9 suites (antes SOLO availability-forecast — dos
#   tests podridos por no correr nunca, arreglados). 126/126.
#
# DATA FIX APLICADO APARTE EN PROD (no es parte del tag): pago
# cmr2tlbxt0111pj0q059uutnz (RES-340681) corregido 250000.00→250.00 (dedazo,
# depósito estándar $250; balance del agreement ya estaba limpio) — vía
# Supabase MCP con nota de auditoría, autorizado por Hector.
#
# PIPELINE: auditoría 2 agentes (rol Innovation) · QA SHIP · aprobación
# explícita de Hector (Fase 1 completa + scope CANCELLED/DRAFT).
# PENDIENTE FASE 2 (no en este tag): void de agreement → anular sus
# AgreementCommission (write-path; hoy 0 filas afectadas en prod).
#
# SIN migración. DEPLOY (BACKEND + WORKER; frontend sin cambio):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#
# SMOKE en prod (Hector): Reports → "Revenue in period" jul 1-13 debe dar
# ~$47.5K (no $335K) y cuadrar con Payments by Day; "Paid at counter" en
# Sales Performance baja a montos reales; drill-down de Commission cuadra
# con la fila del empleado.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.296}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reports/collected-payments.js"
  "backend/src/modules/reports/reports-v2.service.js"
  "backend/src/modules/reports/reports-v2.service.test.mjs"
  "backend/src/modules/reports/payments-by-day.report.js"
  "backend/src/modules/reports/commission-sales-performance.report.js"
  "backend/src/modules/reports/agent-track-record.report.js"
  "backend/src/modules/reports/sales.report.js"
  "backend/src/modules/reports/taxes.report.js"
  "backend/src/modules/reports/toll-per-location.report.js"
  "backend/src/modules/reports/toll-per-vehicle.report.js"
  "backend/src/modules/reports/commission.report.js"
  "backend/src/modules/reports/reports.service.js"
  "backend/src/modules/reports/money-report-filters.test.mjs"
  "backend/package.json"
  ".deploy-notes/2026-07-13-ship-money-reports-audit-fixes-beta296.sh"
)

# ── SANITY GATES ──
for f in reports-v2.service.js payments-by-day.report.js commission-sales-performance.report.js agent-track-record.report.js sales.report.js taxes.report.js toll-per-location.report.js toll-per-vehicle.report.js commission.report.js reports.service.js collected-payments.js; do
  node --check "backend/src/modules/reports/$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
grep -q "COLLECTED_PAYMENT_WHERE" backend/src/modules/reports/reports-v2.service.js || { echo "ABORT: snapshot sin filtro colectado" >&2; exit 1; }
grep -q "COLLECTED_PAYMENT_WHERE" backend/src/modules/reports/commission-sales-performance.report.js || { echo "ABORT: sales-performance sin filtro" >&2; exit 1; }
grep -q "notIn: \['CANCELLED', 'DRAFT'\]" backend/src/modules/reports/sales.report.js || { echo "ABORT: sales sin filtro de status" >&2; exit 1; }
grep -q "notIn: \['VOID'\]" backend/src/modules/reports/toll-per-vehicle.report.js || { echo "ABORT: tolls sin filtro VOID" >&2; exit 1; }
grep -q "money-report-filters.test.mjs" backend/package.json || { echo "ABORT: test:reports sin las suites nuevas" >&2; exit 1; }
( cd backend && npm run test:reports ) || { echo "ABORT: test:reports falló" >&2; exit 1; }
( cd backend && npm run test:tolls ) || { echo "ABORT: test:tolls falló" >&2; exit 1; }
( cd backend && npm run test:commissions ) || { echo "ABORT: test:commissions falló" >&2; exit 1; }
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK (126/126 reports + tolls + commissions; solo READ paths)."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "fix(reports): money-math audit — collected-only payments, no cancelled sales, no void tolls (MONEY-READ)

'Revenue in period' showed \$336K vs \$47.5K real (International, Jul 1-13):
getSnapshot summed RentalAgreementPayment with no status filter and no
AUTH_HOLD exclusion — every security-deposit authorization hold (never
captured) counted as revenue, plus VOID rows. Full audit of the reports
module found the same class in 'Paid at counter' (commission-sales-
performance, agent-track-record) and the legacy overview/daily-ops email
('Collected Payments', via ReservationPayment mirrors), plus: sales/taxes
counted CANCELLED/DRAFT agreements (a void keeps charges selected=true),
toll reports counted VOID transactions, the commission employee drill-down
ran its window one day early (raw UTC parse + fixed-PR tz), the service
catalog double-matched 'Liability Insurance' as LIABILITY+INSURANCE (double
commission in performance reports), and per-vehicle 'revenue' folded in
TAX/DEPOSIT and cancelled reservations.

New collected-payments.js exports the canonical COLLECTED_PAYMENT_WHERE
(status PAID + method != AUTH_HOLD) shared by the snapshot, payments-by-day
and both performance reports so definitions can't diverge. Sales/taxes
exclude CANCELLED/DRAFT (Hector's call), tolls exclude VOID, drill-downs
match their aggregates everywhere. All READ paths — no payment/charge
engine touched, no migration. test:reports now runs 9 suites (was 1; two
rotted tests fixed) — 126/126, tolls 6/6, commissions 26/26. Separate prod
data fix (not in this tag): payment cmr2tlbxt0111pj0q059uutnz corrected
250000.00→250.00 (fat-finger deposit hold), authorized by Hector."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend worker frontend -> recreate. (env-diff-check antes del deploy; sin keys nuevas.)"
