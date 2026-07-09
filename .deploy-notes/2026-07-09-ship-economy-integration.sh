#!/usr/bin/env bash
# Economy (RezLight) booking-source integration — Fases 1-5 COMPLETAS (backend + frontend).
#   bash .deploy-notes/2026-07-09-ship-economy-integration.sh
#
# QUÉ ES: nueva fuente de reservas "Economy" (portal RezLight ASP.NET), análoga a TL
# International pero con login AUTÓNOMO server-side (solo username+password, sin CloudFlare,
# sin IP-binding, sin 2FA — probado desde el droplet, Fase 0 PASS). Tenant-specific +
# location-specific: UNA credencial por tenant cubre varias áreas (MIA, LAX); el modelo
# genérico EconomyLocationConfig decide, por (tenant, área), qué reservas importar
# (área = primeros 3 chars de rgLocPickup, MIAO01→MIA) y con qué ventana de fechas por área.
#
# SHIPS DARK: ECONOMY_INTEGRATION_ENABLED="false" por defecto → el scheduler no arranca y el
# worker no registra economy.sync. Las rutas/panel existen (config editable) pero run-now está
# gated. Cero efecto en prod hasta encender. Master toggle POR TENANT es un kill switch real
# (Tenant.integrationConfig.economy.enabled) que además hay que activar por tenant.
#
# PIPELINE (todo el flujo de CLAUDE.md): Fase 0 PoC PASS → build 1-4 → Innovation+QA →
# fixes M1/S1/S2 → SHIP; Fase 5 mockup aprobado por Hector → build rutas+panel+ventana por
# área → Innovation+Graphic Design → 10 fixes → QA SHIP.
#   Correcciones clave: la búsqueda ordena rgDatePickup DESC y PAGINA (200/pág, cap 25 =
#   5000 filas) cortando en dateFrom — NUNCA barre las ~92k del histórico; ventana UNIÓN para
#   el fetch + precisión POR ÁREA en el filtro; guard cross-tenant en el upsert; badge
#   "Franchise import" para FRANCHISE_ECONOMY; TZ por área en promote manual (LAX→LA);
#   tray de imports source-aware (TL vs Economy distinguibles).
#
# DINERO: solo escribe estimatedTotal; sendConfirmationEmail:false; sin cobros/tarjeta/gateway.
#
# CON MIGRACIONES (aditivas, idempotentes, startup-migrate las aplica al boot):
#   20260705_economy_location_config      — tabla EconomyLocationConfig + relación en Tenant
#   20260709_economy_area_date_window     — lookbackDays/lookaheadDays (nullable) por área
#
# ── SMOKE ──
#   cd backend && npm run test:economy          # 41 verdes
#   npx prisma validate                          # schema válido
#   Con el flag OFF (prod default): logs NO deben mostrar
#     "[worker] registered handler: economy.sync"  → integración inerte.
#   ENCENDER (cuando quieras activar CorpUSA):
#     1) droplet .env: ECONOMY_INTEGRATION_ENABLED=true  (+ INTEGRATION_ENC_KEY seteado)
#     2) restart backend worker
#     3) en el panel (Settings → Integrations → Economy): master toggle ON para el tenant,
#        cargar credenciales (se cifran AES-256), añadir áreas (MIA→Miami, LAX→LA) enabled,
#        opcional ventana por área. Run now para probar; revisar el tray de imports pendientes.
#
# DEPLOY (BACKEND + FRONTEND, CON migraciones auto al boot):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#
# FILES: (ver array FILES abajo — lista explícita, sin git add -A)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
# ⚠️ TAG: verificar el último beta ANTES (git tag -l 'v0.9.0-beta.*' | sort -V | tail -1)
# y usar el siguiente. Override: TAG_OVERRIDE=v0.9.0-beta.NNN bash <este script>
TAG="${TAG_OVERRIDE:-v0.9.0-beta.288}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/integrations/economy/economy.constants.js"
  "backend/src/modules/integrations/economy/economy.service.js"
  "backend/src/modules/integrations/economy/economy.worker.js"
  "backend/src/modules/integrations/economy/economy.scheduler.js"
  "backend/src/modules/integrations/economy/economy.routes.js"
  "backend/src/modules/integrations/economy/economy.test.mjs"
  "backend/src/modules/integrations/economy/economy.routes.test.mjs"
  "backend/src/modules/integrations/tl-international/promotion-matcher.service.js"
  "backend/src/worker.js"
  "backend/src/main.js"
  "backend/src/docs/extra-routes.generated.js"
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260705_economy_location_config/migration.sql"
  "backend/prisma/migrations/20260709_economy_area_date_window/migration.sql"
  "backend/.env.example"
  "backend/package.json"
  "frontend/src/components/settings/EconomyIntegrationPanel.jsx"
  "frontend/src/app/settings/page.js"
  "frontend/src/components/reservations/PendingFranchiseImportsTray.jsx"
  "frontend/src/app/reservations/page.js"
  "frontend/src/app/globals.css"
  "doc/economy-integration-plan-2026-07-05.md"
  "ops/economy-poc/login-poc.mjs"
  ".deploy-notes/2026-07-09-ship-economy-integration.sh"
)

# ── SANITY GATES ──
for f in \
  backend/src/modules/integrations/economy/economy.constants.js \
  backend/src/modules/integrations/economy/economy.service.js \
  backend/src/modules/integrations/economy/economy.worker.js \
  backend/src/modules/integrations/economy/economy.scheduler.js \
  backend/src/modules/integrations/economy/economy.routes.js \
  backend/src/modules/integrations/tl-international/promotion-matcher.service.js \
  backend/src/worker.js backend/src/main.js ; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
# ship-dark: el flag por defecto debe ser "false"
grep -q 'ECONOMY_INTEGRATION_ENABLED="false"' backend/.env.example || { echo "ABORT: ECONOMY_INTEGRATION_ENABLED no está en false por defecto" >&2; exit 1; }
grep -q 'registerEconomySyncWorker' backend/src/worker.js || { echo "ABORT: worker.js no registra economy" >&2; exit 1; }
grep -q "ECONOMY_INTEGRATION_ENABLED" backend/src/worker.js || { echo "ABORT: worker.js no chequea el flag economy" >&2; exit 1; }
# rutas montadas
grep -q 'economyRouter' backend/src/main.js || { echo "ABORT: main.js no monta economyRouter" >&2; exit 1; }
# override S2 aditivo en el matcher compartido (no rompe TL)
grep -q 'overrideLocationId' backend/src/modules/integrations/tl-international/promotion-matcher.service.js || { echo "ABORT: falta overrideLocationId en promotion-matcher" >&2; exit 1; }
# master flag realmente aplicado en el scheduler
grep -q 'masterEnabledFromConfig' backend/src/modules/integrations/economy/economy.scheduler.js || { echo "ABORT: el scheduler no aplica el master flag" >&2; exit 1; }
# migraciones presentes + idempotentes
for m in 20260705_economy_location_config 20260709_economy_area_date_window ; do
  test -f "backend/prisma/migrations/$m/migration.sql" || { echo "ABORT: falta la migración $m" >&2; exit 1; }
  grep -qi 'IF NOT EXISTS' "backend/prisma/migrations/$m/migration.sql" || { echo "ABORT: la migración $m no es idempotente" >&2; exit 1; }
done
grep -q 'test:economy' backend/package.json || { echo "ABORT: package.json no tiene test:economy" >&2; exit 1; }
( cd backend && npm run test:economy ) || { echo "ABORT: test:economy falló" >&2; exit 1; }
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(economy): autonomous RezLight booking-source integration, Fases 1-5 (dark)

New tenant- and location-specific booking source 'Economy' (RezLight ASP.NET),
patterned on TL International but with AUTONOMOUS server-side login (username +
password only — no CloudFlare, no IP-binding, no 2FA; proven from the droplet).
One credential per tenant covers multiple areas; a generic EconomyLocationConfig
decides per (tenant, area) which reservations to import (area = first 3 chars of
rgLocPickup) and with a per-area date window. Reuses ExternalReservation /
ExternalSyncRun / IntegrationCredential / promotion-matcher / duplicate-detector /
integration-crypto.

Backend: economy.service (login + cookie jar + re-login-once, no proxy; 3-param
DataTables lookup with pFilter={docType:R}, DESC-sorted + paginated + capped so it
never sweeps the ~92k history), economy.worker (union-window fetch + per-area
precision filter + rg*/res* mapping + cross-tenant upsert guard), economy.scheduler
(autonomous, per-tenant master-flag enforced), economy.routes (admin-guarded,
tenant-scoped, credentials encrypted + never returned, run-now gated), plus the
EconomyLocationConfig model with nullable per-area lookback/lookahead.

Frontend: EconomyIntegrationPanel (sibling of the TL panel, Ride theme) with master
toggle, encrypted credentials, generic area→location table with per-area import
window, sync status + run-now; the pending-franchise-imports tray is now
source-aware (TL vs Economy distinguishable); FRANCHISE_ECONOMY shows the
franchise-import badge.

Review fixes across two gate passes (Innovation + Graphic Design + QA): bounded
paginated fetch, area-config authoritative for location via an additive
overrideLocationId (TL byte-identical), cross-tenant guard, real per-tenant master
kill switch, per-area promote timezone (LAX→America/Los_Angeles), source-aware tray
labels, panel copy/switch fixes.

Ships DARK behind ECONOMY_INTEGRATION_ENABLED=false: scheduler idle, worker handler
unregistered, run-now gated until flipped AND the per-tenant master toggle is on.
Money confined to estimatedTotal, sendConfirmationEmail:false — no charge path.
41 unit tests; TL/promotion/dedup/scope/cache suites green; two additive idempotent
migrations applied at boot by startup-migrate."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend+frontend → recreate backend worker frontend (migraciones auto al boot)."
echo "Smoke: con el flag OFF, logs NO deben mostrar '[worker] registered handler: economy.sync'."
