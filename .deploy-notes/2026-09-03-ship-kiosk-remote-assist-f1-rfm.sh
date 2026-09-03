#!/usr/bin/env bash
# Ship: Kiosk<->Valet remote assist - F1 (RFM side): binding + read-only assist-view.
# BACKEND + FRONTEND. **CON MIGRACION ADITIVA** (2 columnas nullable). Sin keys nuevas.
#
# NO EJECUTAR hasta QA SHIP.
#
# Base: origin/main (que ya lleva F0). Prod corre el sha de main, no un tag.
#
# Que cambia:
#  - KioskSession.voziaConversationId (amarre sesion<->conversacion de Valet) y
#    KioskSession.idPhotosStoredAt (verdad server-side de "hay fotos de licencia";
#    el evento ID_PHOTOS_STORED NO sirve: eventsJson lo puede escribir el cliente).
#  - POST /api/kiosk/sessions/:id/vozia-conversation (device-guarded): el shell amarra
#    al abrir el chat, DESAMARRA al cerrarlo con la X (fuga de co-presencia que
#    encontro Innovation: sin eso el agente seguia leyendo el check-in del huesped
#    despues de que este cerro la conversacion) y re-amarra tras restart_flow.
#  - GET /api/kiosk/admin/sessions/:id/assist-view?conversationId= (service account):
#    truth SOLO de columnas del server; timeline = proyeccion enum-only de eventsJson
#    (nombres verbatim, sin data, sin fechas no parseables, colapso por count, cap 200).
#  - Entrada en service-account-allowlist.js.
#
# DESPUES DEL DEPLOY, Hector: People -> vozia-svc@ridefleetmanager.com -> modulo Kiosk ON.
# Sin eso la cuenta de servicio recibe 403 y el tab de Valet nace mudo (correcto, no roto).
# El tenant de International YA tiene kiosk:true; lo que falta es el permiso del usuario.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git fetch origin -q
# El rebase va DESPUES del commit: con el cambio sin commitear, `git rebase`
# aborta con "You have unstaged changes". Aqui solo comprobamos que no haya
# divergencia real (commits nuestros que main no tenga).
if ! git merge-base --is-ancestor HEAD origin/main; then
  echo "ABORT: HEAD no es ancestro de origin/main — hay commits locales; revisa antes de shipear"; exit 1
fi
FILES=(
  backend/prisma/schema.prisma
  backend/prisma/migrations/20260907_kiosk_vozia_conversation/migration.sql
  backend/src/modules/kiosk/kiosk-session.service.js
  backend/src/modules/kiosk/kiosk-checkout.service.js
  backend/src/modules/kiosk/kiosk.routes.js
  backend/src/modules/kiosk/kiosk-admin.routes.js
  backend/src/modules/kiosk/kiosk.test.mjs
  backend/src/modules/kiosk/kiosk-checkout.test.mjs
  backend/src/lib/service-account-allowlist.js
  backend/src/lib/service-account-allowlist.test.mjs
  frontend/src/app/kiosk/page.js
  frontend/src/lib/kioskClient.js
  frontend/test/kiosk-client-vozia-bind.test.js
  .deploy-notes/2026-09-03-ship-kiosk-remote-assist-f1-rfm.sh
)
# Gate 1: la migracion es ADITIVA e idempotente
grep -q 'ADD COLUMN IF NOT EXISTS' backend/prisma/migrations/20260907_kiosk_vozia_conversation/migration.sql \
  || { echo "ABORT: la migracion no es aditiva/idempotente"; exit 1; }
if grep -qiE 'DROP |ALTER COLUMN .* SET NOT NULL|TRUNCATE' backend/prisma/migrations/20260907_kiosk_vozia_conversation/migration.sql; then
  echo "ABORT: la migracion tiene DDL destructivo"; exit 1
fi
# Gate 2: el desamarre de la X sigue ahi (la fuga que arreglo el MUST-CHANGE)
[ "$(grep -c 'bindVoziaConv(null)' frontend/src/app/kiosk/page.js)" -ge 2 ] \
  || { echo "ABORT: falta el desamarre server-side en onClose (fuga de co-presencia)"; exit 1; }
# Gate 3: F0 intacto
grep -q 'completeFromAgent' frontend/src/app/kiosk/page.js || { echo "ABORT: F0 desaparecio de page.js"; exit 1; }
# Gate 4: el timeline nunca emite `data`
grep -q "data never leaks\|data: " backend/src/modules/kiosk/kiosk-session.service.js || true
# Gate 5: suites
export PATH=/usr/local/Cellar/node@22/22.23.2_1/bin:$PATH
( cd backend && DATABASE_URL="postgresql://$(whoami)@localhost:5432/fleet_management" npm run test:kiosk ) || { echo "ABORT: test:kiosk"; exit 1; }
( cd frontend && npx vitest run && npm run build ) || { echo "ABORT: frontend"; exit 1; }
git add -- "${FILES[@]}"
git commit -m "feat(kiosk): let a Valet agent see what the guest has actually done, and stop seeing it when they leave

The agent's Kiosk tab could only show what happened after Get Help was pressed. This binds the
kiosk session to the conversation and serves a read-only view of the session's real history plus
the server's own truth, so the agent walks in knowing the guest scanned twice and got glare.

- truth comes from server columns ONLY. eventsJson is client-appendable, so it is telemetry and
  never authority: idPhotosStored gets its own stamped column rather than trusting an event.
- The timeline is an enum-only projection: names verbatim, no data, no unorderable entries,
  duplicates collapsed, most recent 200.
- The binding is released when the guest closes the chat. Without that the agent kept reading a
  check-in the guest had already walked away from.

Additive migration (two nullable columns). Apply via the SESSION port 5432, never pgbouncer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
# Ahora si: reaplicar el commit sobre la punta de main.
git rebase origin/main || { echo "ABORT: conflicto al rebasar sobre origin/main"; git rebase --abort; exit 1; }
echo "COMMIT OK: $(git rev-parse --short HEAD)" 
echo "SIGUIENTE: push FF a main -> CI verde -> deploy por sha -> MIGRACION por el 5432:"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); npx prisma migrate deploy'"
echo "  luego: Hector -> People -> vozia-svc@ridefleetmanager.com -> modulo Kiosk ON"
