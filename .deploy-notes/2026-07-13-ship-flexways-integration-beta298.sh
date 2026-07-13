#!/usr/bin/env bash
# Flexways (MobilityPS) — 3ra integración autónoma de booking-source + el refactor
# source-aware compartido (R0). Ship DARK.
#   bash .deploy-notes/2026-07-13-ship-flexways-integration-beta298.sh
#
# QUÉ: (R0) módulo compartido `booking-source/` extraído de economy/nu (promote,
# customer-autocreate, scheduler-factory, window, http-common + promotion-matcher/
# duplicate-detector movidos con shims en tl-international/ — CERO cambio de
# comportamiento, economy/nu byte-idénticos). (F) integración Flexways completa:
# service con auto-login HEADLESS (patrón TL via withPage singleton + ProxyAgent
# residencial opcional; NO resuelve/bypasea captcha — la página emite su token v3),
# parser DataTables JSON (LATAM DD/MM/YYYY), worker fino que delega a las piezas
# compartidas, scheduler via factory, rutas clon de NU (admin-gated), panel
# autónomo. MULTI-SEDE (FlexwaysLocationConfig por idSede).
#
# SHIP DARK: FLEXWAYS_INTEGRATION_ENABLED default false → worker NO registra
# handler/scheduler; rutas montadas (admin-gated) pero sin polling. Encender el
# flag + poner credenciales es lo ÚNICO que activa el sync. Blast radius = 0 hoy.
#
# GAP DEL RECON (TODO explícito, no bloquea dark): ACRISS/total/email del cliente
# viven en el DETALLE por reserva (no en el grid) → mapeados como null → con
# vehicleAcriss null TODA reserva cae a MANUAL_REVIEW (evaluatePromotion paso
# ACRISS) → ninguna se auto-promueve con datos incompletos. El fetch de detalle +
# el PoC de login headless desde el droplet se hacen con credenciales en vivo.
#
# PIPELINE: Innovation OK (sin must-change) · Graphic Design OK (1 must-change
# aplicado: pill del header derivado del health en vivo) · QA SHIP. Tests:
# test:flexways 17/17 (nuevo), test:booking-source 38 (nuevo); regresión sin tocar
# tests: test:nu 60 (VIVO en prod), test:economy 41, tl-international 49. prisma
# validate OK. Migración additive/idempotente espejo de NuLocationConfig.
#
# ⚠️ .env DEL DROPLET: este batch añade 8 keys FLEXWAYS_* a .env.example →
# env-diff-check FALLARÁ hasta ponerlas en el .env del droplet (7 con defaults,
# FLEXWAYS_PROXY_URL vacío). Ponlas ANTES del deploy (mismo procedimiento que las
# ECONOMY_*/NU_*). FLEXWAYS_INTEGRATION_ENABLED="false" — NO encender aún.
#
# DEPLOY (BACKEND + WORKER + FRONTEND, CON migración additive):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   # migración additive (puerto SESIÓN 5432, nunca pgbouncer):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#
# SMOKE en prod (dark): 3 contenedores healthy, boot limpio (la cadena estática
# main.js→flexways.routes→worker/service/scheduler/constants→booking-source/* debe
# resolver — si falta un import top-level NO bootea aunque el flag esté off),
# /health 200, worker log SIN "flexways.sync registered" (flag off = correcto),
# tabla FlexwaysLocationConfig creada. El panel aparece en Settings→Integrations→
# Flexways (configurable pero inerte hasta flag+credenciales).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
TAG="${TAG_OVERRIDE:-v0.9.0-beta.298}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

# FILES[]: la cadena ENTERA de imports estáticos (QA: main.js importa flexwaysRouter
# estáticamente → arrastra flexways/* → booking-source/* + los shims). Si falta uno,
# el backend no bootea aunque el flag esté off (causa #1 de boot crash).
FILES=(
  # R0 — módulo compartido
  "backend/src/modules/integrations/booking-source/promote.js"
  "backend/src/modules/integrations/booking-source/customer-autocreate.js"
  "backend/src/modules/integrations/booking-source/scheduler-factory.js"
  "backend/src/modules/integrations/booking-source/window.js"
  "backend/src/modules/integrations/booking-source/http-common.js"
  "backend/src/modules/integrations/booking-source/promotion-matcher.service.js"
  "backend/src/modules/integrations/booking-source/duplicate-detector.service.js"
  "backend/src/modules/integrations/booking-source/booking-source.test.mjs"
  # shims tl-international (re-export → ningún import existente cambia)
  "backend/src/modules/integrations/tl-international/promotion-matcher.service.js"
  "backend/src/modules/integrations/tl-international/duplicate-detector.service.js"
  # F — Flexways
  "backend/src/modules/integrations/flexways/flexways.constants.js"
  "backend/src/modules/integrations/flexways/flexways.service.js"
  "backend/src/modules/integrations/flexways/flexways.worker.js"
  "backend/src/modules/integrations/flexways/flexways.scheduler.js"
  "backend/src/modules/integrations/flexways/flexways.routes.js"
  "backend/src/modules/integrations/flexways/flexways.test.mjs"
  "backend/src/modules/integrations/flexways/flexways.routes.test.mjs"
  # schema + migración additive
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260713_flexways_integration/migration.sql"
  # wiring gateado + env + test chain
  "backend/src/main.js"
  "backend/src/worker.js"
  "backend/package.json"
  "backend/.env.example"
  # frontend
  "frontend/src/components/settings/FlexwaysIntegrationPanel.jsx"
  "frontend/src/app/settings/page.js"
  "frontend/src/app/reservations/page.js"
  "frontend/src/components/reservations/PendingFranchiseImportsTray.jsx"
  ".deploy-notes/2026-07-13-ship-flexways-integration-beta298.sh"
)

# ── SANITY GATES ──
for f in constants service worker scheduler routes; do
  node --check "backend/src/modules/integrations/flexways/flexways.$f.js" || { echo "ABORT: node --check flexways.$f" >&2; exit 1; }
done
node --check backend/src/main.js || { echo "ABORT: node --check main.js" >&2; exit 1; }
node --check backend/src/worker.js || { echo "ABORT: node --check worker.js" >&2; exit 1; }
grep -q "FLEXWAYS_INTEGRATION_ENABLED" backend/src/worker.js || { echo "ABORT: worker.js no gatea flexways bajo el flag" >&2; exit 1; }
grep -q "flexwaysRouter" backend/src/main.js || { echo "ABORT: main.js no monta flexwaysRouter" >&2; exit 1; }
grep -q '"false"' <(grep FLEXWAYS_INTEGRATION_ENABLED backend/.env.example) || { echo "ABORT: FLEXWAYS_INTEGRATION_ENABLED no está en false (ship dark)" >&2; exit 1; }
grep -q "test:flexways" backend/package.json || { echo "ABORT: falta test:flexways" >&2; exit 1; }
( cd backend && npm run test:flexways ) || { echo "ABORT: test:flexways falló" >&2; exit 1; }
( cd backend && npm run test:booking-source ) || { echo "ABORT: test:booking-source falló" >&2; exit 1; }
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK. (test:nu 60 / test:economy 41 regresión → validados en QA; DB-backed corren en CI.)"

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(integrations): Flexways (MobilityPS) autonomous booking-source + shared booking-source module (dark)

R0: extract the duplicated economy/nu logic into booking-source/ (promote,
customer-autocreate, scheduler-factory, window, http-common) and move
promotion-matcher/duplicate-detector there with re-export shims in
tl-international/ — zero behavior change (economy/nu byte-identical, their
suites pass unmodified). F: Flexways integration — autonomous headless
auto-login (TL pattern via the withPage singleton + optional residential
ProxyAgent; the login page issues its own reCAPTCHA v3 token, never solved/
bypassed), DataTables JSON parser (LATAM day-first dates), thin worker
delegating to the shared promoter, scheduler via the factory, NU-cloned
admin routes, autonomous panel. Multi-sede via FlexwaysLocationConfig
(idSede). Ships DARK (FLEXWAYS_INTEGRATION_ENABLED=false → no handler/
scheduler registered; routes mounted but inert). Recon gap (ACRISS/total/
email live on the per-reservation detail page) mapped as null → every
Flexways row lands in MANUAL_REVIEW, so nothing auto-promotes with
incomplete data; the detail fetch + live login PoC come with credentials.
Additive FlexwaysLocationConfig migration (mirror of NuLocationConfig).
Pipeline: Innovation OK, Graphic Design OK, QA SHIP. test:flexways 17,
test:booking-source 38; nu 60 / economy 41 unchanged."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: añadir las 8 keys FLEXWAYS_* al .env (flag=false) -> env-diff-check -> build backend worker frontend -> recreate -> migrate deploy (5432)."
