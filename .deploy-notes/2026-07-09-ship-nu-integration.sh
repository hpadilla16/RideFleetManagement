#!/usr/bin/env bash
# NU Car Rentals booking-source integration — Fases 1-5 COMPLETAS (backend + frontend).
#   bash .deploy-notes/2026-07-09-ship-nu-integration.sh
#
# QUÉ ES: nueva fuente de reservas "NU Car Rentals" (portal de afiliados
# affiliates.nucarrentals.com, ASP.NET WebForms + Telerik). Análoga a Economy pero:
#   - Login username/password con truco Telerik ClientState (el RadTextBox lee el valor
#     del hidden *_ClientState, no del input plano). Auth por SESIÓN (ASP.NET_SessionId),
#     sin IP-binding, sin 2FA → AUTÓNOMO desde el droplet, sin proxy (probado en vivo).
#   - Reservas vía postback del RadGrid en affiliates.aspx con RadDatePicker coordinado
#     (START/END + *_dateInput_ClientState + calendar_AD) + __EVENTTARGET=btnRefreshGrid,
#     parseadas del HTML del grid (20 columnas, 2 estructurales). Validado EN VIVO: 459
#     reservas en ventana de 30 días, codeCounts PP=280/OP=49/blank=130.
#   - La cuenta NU está scoped a UNA localidad → NU→FLL es 1:1 (config de una sola fila).
#   - PREPAGO MIXTO: Code PP/OP = prepago (badge, no cobrar en counter); Code en blanco =
#     pago a destino (el counter cobra). isPrepaid por reserva (ExternalReservation Y la
#     Reservation promovida, campo estructurado — NO se parsea de notes).
#
# SHIPS DARK: NU_INTEGRATION_ENABLED="false" por defecto → scheduler no arranca, worker no
# registra nu.sync. Rutas/panel existen (config editable) pero run-now gated (409 master off /
# 503 sin redis). Cero efecto en prod hasta encender + master toggle por tenant.
#
# PIPELINE COMPLETO (CLAUDE.md): Fase 0 PoC login PASS → recon vía Chrome → build 1-4 →
# Innovation+QA (2 must-change: pager silent-miss + parser fail-loud) → Fase 5 mockup aprobado
# → build rutas+panel → Innovation+Graphic Design (2 must-change: prepaid estructurado + config
# 1:1 determinística) → QA SHIP. Endurecido: NuLayoutError si driftean las columnas,
# cross-check del total del pager (status ATTENTION si truncó), telemetría de tokens.
#
# DINERO: solo escribe estimatedTotal; sendConfirmationEmail:false; sin cobros/tarjeta —
# ni siquiera las pago-a-destino (esas las cobra el counter manualmente). isPrepaid es
# display-only, nunca gatilla un cobro.
#
# CON MIGRACIONES (aditivas, idempotentes, startup-migrate las aplica al boot):
#   20260709_nu_integration        — tabla NuLocationConfig + relación en Tenant +
#                                     ExternalReservation.isPrepaid
#   20260709_reservation_isprepaid — Reservation.isPrepaid (nullable; null = sin cambio para
#                                     TL/Economy/staff/website — cero impacto a flujos vivos)
#
# ── SMOKE ──
#   cd backend && npm run test:nu               # 60 verdes
#   npx prisma validate
#   Con el flag OFF (prod default): logs del worker NO deben mostrar
#     "[worker] registered handler: nu.sync"  → integración inerte.
#   ENCENDER (cuando quieras activar CorpUSA/FLL):
#     1) crear la localidad FLL en Ride (Settings → Locations) si no existe
#     2) droplet .env: NU_INTEGRATION_ENABLED=true (INTEGRATION_ENC_KEY ya seteado)
#     3) restart backend worker  (⚠️ build INCLUYE worker — imagen propia)
#     4) panel Settings → Integrations → NU Car Rentals: master ON, credenciales (cifradas),
#        mapear la cuenta → FLL enabled, Run now, revisar el tray de imports pendientes.
#
# DEPLOY (BACKEND + WORKER + FRONTEND, CON migraciones auto al boot):
#   git fetch --tags && git checkout <TAG>
#   docker compose -f docker-compose.prod.yml build backend worker frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   ⚠️ El servicio `worker` tiene su PROPIO build (imagen ridefleetmanagement-worker) — SIEMPRE
#      inclúyelo en el build o el nu.sync worker se queda con código viejo.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"
# ⚠️ TAG: verificar el último beta ANTES (git tag -l 'v0.9.0-beta.*' | sort -V | tail -1)
TAG="${TAG_OVERRIDE:-v0.9.0-beta.289}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "ABORT: el tag $TAG ya existe — usa TAG_OVERRIDE con el próximo número libre" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/integrations/nu/nu.constants.js"
  "backend/src/modules/integrations/nu/nu.service.js"
  "backend/src/modules/integrations/nu/nu.worker.js"
  "backend/src/modules/integrations/nu/nu.scheduler.js"
  "backend/src/modules/integrations/nu/nu.routes.js"
  "backend/src/modules/integrations/nu/nu.test.mjs"
  "backend/src/modules/integrations/nu/nu.routes.test.mjs"
  "backend/src/worker.js"
  "backend/src/main.js"
  "backend/src/modules/reservations/reservations.service.js"
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260709_nu_integration/migration.sql"
  "backend/prisma/migrations/20260709_reservation_isprepaid/migration.sql"
  "backend/.env.example"
  "backend/package.json"
  "frontend/src/components/settings/NuIntegrationPanel.jsx"
  "frontend/src/app/settings/page.js"
  "frontend/src/app/reservations/page.js"
  "frontend/src/components/reservations/PendingFranchiseImportsTray.jsx"
  "doc/nu-integration-plan-2026-07-09.md"
  "ops/nu-poc/login-poc.mjs"
  "ops/nu-poc/list-fetch-poc.mjs"
  ".deploy-notes/2026-07-09-ship-nu-integration.sh"
)

# ── SANITY GATES ──
for f in \
  backend/src/modules/integrations/nu/nu.constants.js \
  backend/src/modules/integrations/nu/nu.service.js \
  backend/src/modules/integrations/nu/nu.worker.js \
  backend/src/modules/integrations/nu/nu.scheduler.js \
  backend/src/modules/integrations/nu/nu.routes.js \
  backend/src/worker.js backend/src/main.js \
  backend/src/modules/reservations/reservations.service.js ; do
  node --check "$f" || { echo "ABORT: node --check $f" >&2; exit 1; }
done
grep -q 'NU_INTEGRATION_ENABLED="false"' backend/.env.example || { echo "ABORT: NU_INTEGRATION_ENABLED no está en false por defecto" >&2; exit 1; }
grep -q 'registerNuSyncWorker' backend/src/worker.js || { echo "ABORT: worker.js no registra nu" >&2; exit 1; }
grep -q "NU_INTEGRATION_ENABLED" backend/src/worker.js || { echo "ABORT: worker.js no chequea el flag nu" >&2; exit 1; }
grep -q 'nuRouter' backend/src/main.js || { echo "ABORT: main.js no monta nuRouter" >&2; exit 1; }
for m in 20260709_nu_integration 20260709_reservation_isprepaid ; do
  test -f "backend/prisma/migrations/$m/migration.sql" || { echo "ABORT: falta la migración $m" >&2; exit 1; }
  grep -qi 'IF NOT EXISTS' "backend/prisma/migrations/$m/migration.sql" || { echo "ABORT: la migración $m no es idempotente" >&2; exit 1; }
done
grep -q 'test:nu' backend/package.json || { echo "ABORT: package.json no tiene test:nu" >&2; exit 1; }
( cd backend && npm run test:nu ) || { echo "ABORT: test:nu falló" >&2; exit 1; }
( cd backend && npx prisma validate ) || { echo "ABORT: prisma validate falló" >&2; exit 1; }
echo "Guards OK."

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(nu): autonomous NU Car Rentals booking-source integration, Fases 1-5 (dark)

New tenant/location-specific booking source 'NU Car Rentals' (affiliates.nucarrentals.com,
ASP.NET WebForms + Telerik). Autonomous session login (Telerik ClientState trick), no proxy;
reservations via affiliates.aspx RadGrid postback with coordinated RadDatePicker fields +
btnRefreshGrid, parsed from the grid HTML (20-col layout). Live-validated: 459 rows / 30-day
window, prepaid mix PP=280/OP=49/blank=130. NU account is location-scoped 1:1 (NuLocationConfig,
single active row → FLL). Prepaid (Code PP/OP) vs pay-at-destination (blank) tracked via a
structured isPrepaid on ExternalReservation AND the promoted Reservation (not notes-parsed).

Reuses ExternalReservation/ExternalSyncRun/IntegrationCredential/AcrissCategoryMap/crypto/
promotion-matcher(overrideLocationId)/duplicate-detector. Net-new: nu.service (login + date
postback + RadGrid parser, hardened with header-anchor drift guard→NuLayoutError, pager
total-count cross-check→ATTENTION, unexpected-token telemetry), nu.worker (isPrepaid, ACRISS→
vehicleType, deterministic single-config), nu.scheduler (autonomous, master-flag enforced),
nu.routes (admin, tenant-scoped, creds encrypted+never returned, run-now gated, 1:1 config 409),
NuIntegrationPanel (sibling of the Economy panel), 3-way settings switcher, source-aware NU tray.

Ships DARK behind NU_INTEGRATION_ENABLED=false. Money confined to estimatedTotal,
sendConfirmationEmail:false — no charge path (counter collects pay-at-destination manually).
60 unit tests; economy/scope/cache/reservations/TL suites green. Two additive idempotent
migrations (NuLocationConfig + ExternalReservation.isPrepaid; Reservation.isPrepaid nullable →
null for non-NU, zero impact to existing flows), applied at boot by startup-migrate."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Droplet: build backend worker frontend → recreate backend worker frontend."
echo "Smoke: con el flag OFF, logs del worker NO deben mostrar '[worker] registered handler: nu.sync'."
