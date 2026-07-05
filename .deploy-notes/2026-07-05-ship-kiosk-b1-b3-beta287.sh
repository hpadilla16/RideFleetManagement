#!/usr/bin/env bash
# v0.9.0-beta.287 — Ride Kiosk Fases B1→B3 (self-checkout end-to-end, SANDBOX payment).
#   bash .deploy-notes/2026-07-05-ship-kiosk-b1-b3-beta287.sh
#
# Backend + Frontend, CON migración ADITIVA (20260705_kiosk_core — 3 tablas + 3 enums
# nuevos, cero cambios a tablas existentes). Módulo 'kiosk' default OFF por tenant
# (opt-in) → deploy invisible hasta que Hector prenda el módulo en un tenant de prueba.
# Pipeline completo: Innovation ×2 + Graphic Design ×2 + QA SHIP en cada fase
# (B1/B2/B3a/B3b). 80/80 test:kiosk · 54/54 reservations · 6/6 tolls · 4/4
# customer-inspection · frontend build limpio · import walk OK.
#
# QUÉ:
#   - /api/kiosk/*: pairing de devices (código 6 díg. hasheado + lockout por IP, token
#     SHA-256 rotable), sesiones con telemetría de funnel, lookup enmascarado con lockout
#     POR DEVICE, verify-id (AAMVA + selfie; gate server-side idVerifiedAt), assign
#     de vehículo ATÓMICO, upsell engine (UpsellRule × AdditionalService × días; tax
#     recomputado vía recomputeTaxRow; prepaid/linked-fee nunca ofrecidos), firma con la
#     state machine REAL del checkout-session (initials por sección, cascade anti-beta.152),
#     complete con lockbox SOLO tras CLOSED + QR de inspección (beta.160), escalación enum.
#   - PAGO = SANDBOX ONLY: /sandbox-payment exige KIOSK_PAYMENT_SANDBOX=true Y en
#     producción TAMBIÉN KIOSK_PAYMENT_SANDBOX_ALLOW_PROD=true (double-key). Ambas keys
#     deliberadamente FUERA de .env.example. CERO código de payment-gateway tocado.
#   - Frontend: /kiosk (wizard tablet fullscreen K1-K10 + errores, EN/ES, idle-wipe,
#     device token en X-Kiosk-Token) · /kiosks (admin devices/sesiones/key-handoff) ·
#     Settings → Kiosk Upsell · card "Kiosk Escalations" en dashboard.
#   - Compartidos (diffs mínimos, QA-auditados): reservation-extend (export
#     recomputeTaxRow + 'KIOSK_UPSELL' en PER_DAY_LIKE_SOURCES), tolls (KIOSK_UPSELL en
#     sources de toll-package), customer-inspection (opción {closedSession} + link),
#     reports (KPI kioskEscalations), module-access ('kiosk', tenant default OFF
#     fail-closed).
#
# OJO SECUENCIA: el commit 90677c1 (employee-app Fase 1, frontend/mobile shell, smoke on
# device 2026-07-05) ya está en la rama y VIAJA con este tag — el rebuild del frontend lo
# incluye. Los archivos de otros workstreams EN CURSO (tenant-rate-limit.js, sunpass doc,
# training/INDEX.md) NO van en este FILES[] y quedan uncommitted.
#
# ── SMOKE TEST (Hector, tenant de prueba, NUNCA International hasta validar) ──
#   0. (dev/droplet) Para probar pago sandbox en prod: exportar las DOS keys en el .env
#      del droplet (KIOSK_PAYMENT_SANDBOX=true + KIOSK_PAYMENT_SANDBOX_ALLOW_PROD=true)
#      y QUITARLAS al terminar el smoke. Sin ellas el flujo para en PAYMENT con 403.
#   1. Settings → módulos del tenant de prueba → prender "Kiosk".
#   2. /kiosks → Pair new kiosk → código de 6 díg. → abrir /kiosk en tablet/browser → pair.
#      Header debe leer "<Tenant> · <Location> · <Kiosk name>" y dot verde online.
#   3. Reserva de prueba (NEW o CONFIRMED, pickup hoy, con vehículo disponible de la clase):
#      lookup por confirmación → summary → scan de licencia EN VIVO (verifica que la foto
#      de licencia quede como evidencia) → selfie → checks verdes → paquetes (decline
#      honesto "No extras" visible) → back desde payment a offers y cambiar selección →
#      Simulate payment (SANDBOX badge) → initials + firma → lockbox code + QR inspección.
#   4. Contrato por email: odometer/fuel NO deben salir "-" (anti-beta.152) + entrada de
#      mileage CHECKOUT en el perfil del vehículo + vehículo ON_RENT.
#   5. Admin: toggle walk-up en Manage (PATCH) — el click que ningún agente pudo dar.
#      KPIs de /kiosks NO deben cambiar al filtrar por outcome (deep-link ESCALATED).
#   6. Lockout: 5 lookups fallidos → 429 en sesión NUEVA del mismo device; reissue de
#      pairing code lo limpia.
#   7. Verificar que un tenant SIN el módulo no ve nav/dashboard card y /api/kiosk admin
#      da 403 (default OFF fail-closed).
#
# DEPLOY (BACKEND + FRONTEND + MIGRACIÓN):
#   bash scripts/env-diff-check.sh   # kiosk NO añade keys requeridas (sandbox keys son opt-in manual)
#   git fetch --tags && git checkout v0.9.0-beta.287
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   # Migración ADITIVA por el puerto de SESIÓN 5432 (nunca 6543):
#   docker exec fleet-backend-prod sh -c 'export DATABASE_URL=$(echo "$DATABASE_URL" | sed -e "s/:6543/:5432/" -e "s/[?&]pgbouncer=true//"); npx prisma migrate deploy'
#   # NOTA migración: 20260705_kiosk_core nunca se ha deployado a prod → corre fresca.
#   #   Si alguna DB de staging la registró ANTES de 2026-07-05 (ediciones in-place
#   #   posteriores añadieron lookupMisses/lookupLockedUntil/idVerifiedAt), migrate deploy
#   #   la SALTA ahí — pegar a mano los ALTER TABLE ... ADD COLUMN IF NOT EXISTS del final
#   #   del archivo por el 5432 (son idempotentes).
#   # Post-deploy: 3 contenedores healthy + boot limpio (sin MODULE_NOT_FOUND/TypeError)
#   #   + /health 200 + hard refresh del frontend.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.287"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

FILES=(
  # backend — módulo kiosk (nuevo)
  backend/src/modules/kiosk/kiosk-device.service.js
  backend/src/modules/kiosk/kiosk-auth.middleware.js
  backend/src/modules/kiosk/kiosk-session.service.js
  backend/src/modules/kiosk/kiosk-offers.service.js
  backend/src/modules/kiosk/kiosk-checkout.service.js
  backend/src/modules/kiosk/kiosk.routes.js
  backend/src/modules/kiosk/kiosk-admin.routes.js
  backend/src/modules/kiosk/kiosk.test.mjs
  backend/src/modules/kiosk/kiosk-offers.test.mjs
  backend/src/modules/kiosk/kiosk-checkout.test.mjs
  backend/src/lib/module-access-kiosk.test.mjs
  # backend — migración aditiva
  backend/prisma/migrations/20260705_kiosk_core/migration.sql
  backend/prisma/schema.prisma
  # backend — compartidos (diffs mínimos QA-auditados)
  backend/src/lib/module-access.js
  backend/src/main.js
  backend/package.json
  backend/src/modules/reservations/reservation-extend.service.js
  backend/src/modules/reservations/reservation-extend.test.mjs
  backend/src/modules/tolls/tolls.service.js
  backend/src/modules/customer-inspection/customer-inspection.service.js
  backend/src/modules/customer-inspection/customer-inspection.test.mjs
  backend/src/modules/reports/reports.service.js
  # frontend — kiosk app + admin (nuevo)
  frontend/src/lib/kioskClient.js
  frontend/src/app/kiosk/layout.js
  frontend/src/app/kiosk/page.js
  frontend/src/app/kiosk/kiosk.css
  frontend/src/app/kiosks/page.js
  frontend/src/components/kiosk/KioskUiContext.js
  frontend/src/components/kiosk/SignaturePad.jsx
  frontend/src/components/settings/KioskUpsellSettings.jsx
  # frontend — compartidos
  frontend/src/lib/moduleAccess.js
  frontend/src/components/AppShell.jsx
  frontend/src/components/loaner/LicenseScanner.jsx
  frontend/src/app/page.js
  frontend/src/app/settings/page.js
  frontend/src/locales/en.json
  frontend/src/locales/es.json
  # docs + ship
  doc/kiosk-autonomo-plan-2026-06-11.md
  doc/kiosk-e2e-spec-2026-07-04.md
  doc/kiosk-mockups-2026-07-04.html
  .deploy-notes/2026-07-05-ship-kiosk-b1-b3-beta287.sh
)

# Boot-safety: todo import top-level nuevo de main.js está en FILES[] (kiosk.routes.js +
# kiosk-admin.routes.js) — verificado también por SKIP_LISTEN import walk en QA.
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"
git commit -m "feat(kiosk): Fases B1-B3 — self-checkout kiosk end-to-end (sandbox payment)

Module 'kiosk' (tenant opt-in, default OFF): device pairing + hashed rotatable
tokens, masked reservation lookup w/ per-device lockout, AAMVA verify-id with
server-side idVerifiedAt gate, atomic vehicle assign, per-channel upsell engine
(tax recompute, toll-package coverage, linked-fee fail-closed), real
checkout-session cascade with anti-beta.152 metric stamping, lockbox-after-CLOSED
complete + inspection QR, enum escalation + dashboard KPI. Frontend: /kiosk
fullscreen wizard (EN/ES, idle-wipe, PII-free storage), /kiosks admin, Settings
Kiosk Upsell. Payment is SANDBOX-ONLY (double-keyed against production); real
iPOS payment-link lands in B5 behind Hector's money gate.

Pipeline: Innovation + Graphic Design + QA SHIP on every phase (B1/B2/B3a/B3b)."
git tag "$TAG"
echo "Committed + tagged $TAG. Push with: git push origin $BRANCH --tags"
