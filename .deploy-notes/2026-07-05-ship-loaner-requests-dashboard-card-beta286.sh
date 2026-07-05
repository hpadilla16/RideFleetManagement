#!/usr/bin/env bash
# v0.9.0-beta.286 — Card "Solicitudes de Cortesía" en el Ops Hub (loaner requests del storefront).
#   bash .deploy-notes/2026-07-05-ship-loaner-requests-dashboard-card-beta286.sh
#
# Backend + Frontend, SIN migración. ZERO charge logic.
#
# QUÉ: el storefront de Rent & Go (rent-by-vphmotors) somete solicitudes de cortesía vía
# POST /api/public/loaner/request → LoanerRequest status RECEIVED, pero NADIE se enteraba
# a menos que abriera Loaner → Requests a mano. Ahora el dashboard lo anuncia con el mismo
# patrón self-clearing de "Inspections to Review":
#   • KPI kpis.loanerRequestsPending en el overview (count RECEIVED por tenant; usa el
#     @@index([tenantId, status]) existente; .catch(()=>0) igual que sus hermanos).
#   • Card en el Ops Hub SOLO cuando moduleAccess.loaner === true Y count > 0, click →
#     /loaner. Al marcar CONTACTED/CONVERTED/CLOSED el count baja y el card desaparece.
#
# CAMBIOS:
#   backend/src/modules/reports/reports.service.js
#     - Promise.all del overview: + prisma.loanerRequest.count({ tenantId?, status:'RECEIVED' })
#     - kpis: + loanerRequestsPending (key aditiva — ningún consumer existente se rompe)
#   frontend/src/app/page.js
#     - const loanerRequestsPending + card 'loaner-requests-pending' en nextItems (antes del
#       card estático Loaner Lane) + dep en el useMemo
#   frontend/src/locales/en.json / es.json
#     - dashboard.loanerRequests / loanerRequestsDetail_one/_other / loanerRequestsNote /
#       reviewRequests (en: "Courtesy Requests" · es: "Solicitudes de Cortesía")
#
# Verificado local: node --check backend ✅ · JSON locales válidos ✅ · Innovation + Graphic
# Design + QA del pipeline OK. El 'next build' del docker valida el JSX.
#
# DEPLOY en el droplet (BACKEND + FRONTEND):
#   git fetch --tags && git checkout v0.9.0-beta.286
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend frontend
#   # Sin migración. Hard refresh tras el deploy.
# Verificar: someter una solicitud desde el website (o usar una RECEIVED existente) → card
#   "Solicitudes de Cortesía" aparece en el Ops Hub con el count → click abre /loaner →
#   marcar CONTACTED → refrescar dashboard → el card desaparece. Cuenta sin módulo loaner
#   (p.ej. ircadmin) NO ve el card.
#
# FILES:
#   backend/src/modules/reports/reports.service.js
#   frontend/src/app/page.js
#   frontend/src/locales/en.json
#   frontend/src/locales/es.json
#   .deploy-notes/2026-07-05-ship-loaner-requests-dashboard-card-beta286.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.286"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/reports/reports.service.js"
  "frontend/src/app/page.js"
  "frontend/src/locales/en.json"
  "frontend/src/locales/es.json"
  ".deploy-notes/2026-07-05-ship-loaner-requests-dashboard-card-beta286.sh"
)

# ── SANITY GATES ──
node --check backend/src/modules/reports/reports.service.js || { echo "ABORT: node --check reports.service" >&2; exit 1; }
grep -q "loanerRequestsPendingCount" backend/src/modules/reports/reports.service.js || { echo "ABORT: falta el count en el overview" >&2; exit 1; }
grep -q "loanerRequestsPending: loanerRequestsPendingCount" backend/src/modules/reports/reports.service.js || { echo "ABORT: falta el kpi" >&2; exit 1; }
grep -q "loaner-requests-pending" frontend/src/app/page.js || { echo "ABORT: falta el card en page.js" >&2; exit 1; }
grep -q "loanerRequestsPending, totalVehicles" frontend/src/app/page.js || { echo "ABORT: falta el dep del useMemo" >&2; exit 1; }
node -e "const en=require('./frontend/src/locales/en.json').dashboard, es=require('./frontend/src/locales/es.json').dashboard; for (const k of ['loanerRequests','loanerRequestsDetail_one','loanerRequestsDetail_other','loanerRequestsNote','reviewRequests']) { if(!en[k]||!es[k]) { console.error('ABORT: i18n falta '+k); process.exit(1);} }" || exit 1
grep -q "model LoanerRequest" backend/prisma/schema.prisma || { echo "ABORT: LoanerRequest no está en schema" >&2; exit 1; }
echo "Guards OK. (El 'next build' del docker valida el JSX.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(dashboard): Ops Hub card for storefront loaner requests awaiting contact

Courtesy-car requests submitted from the public storefront (LoanerRequest
status RECEIVED) were invisible unless an advisor opened Loaner > Requests
manually. Adds kpis.loanerRequestsPending to the reports overview (cheap
count on the existing [tenantId, status] index, additive key) and a
self-clearing Ops Hub card gated by moduleAccess.loaner that click-throughs
to /loaner and disappears once requests move past RECEIVED. i18n en/es.
No migration; no charge logic."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build BACKEND + FRONTEND → force-recreate ambos. Sin migración."
