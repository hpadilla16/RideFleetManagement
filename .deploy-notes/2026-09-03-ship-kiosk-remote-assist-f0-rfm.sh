#!/usr/bin/env bash
# Ship: Kiosk↔Valet remote assist — F0 (RFM side): honest `flow_completed` + kioskSessionId.
# FRONTEND ONLY. Sin migración. Sin backend. QA: SHIP (2026-09-03, MINOR-1 aplicado).
#
# BASE: 1b6f347d = punta de origin/main = lo que corre el droplet (deployer read-only 2026-09-03).
# Prod ya NO va por tag: corre el sha de main. Este script solo COMMITEA en la rama del worktree.
# Push a main + deploy por sha los hace el deployer/Hector, con smoke en el iPad de International
# (el cambio NO es dark ahí: voziaKioskConfig → valet.ridefleetmanager.com desde 2026-07-20).
#
# Qué cambia (frontend/src/app/kiosk/page.js, frontend/src/lib/voziaBridge.js, locales, test):
#  - flow_completed: completeSession() PRIMERO con el overlay vivo; fallo → ack refused:true + reason
#    enum + toast 6 s con el paso pendiente + evento VOZIA_COMMAND_REFUSED (1 vez por llave);
#    éxito → DONE + overlay cerrado + applied. Guards: in-flight, cambio de conversación, routeFatal.
#  - kiosk-state lleva kioskSessionId (contrato v4 aditivo; Valet lo ignora hasta F1).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
BASE=1b6f347d
git merge-base --is-ancestor "$BASE" HEAD || { echo "ABORT: HEAD no desciende de $BASE (base de prod)"; exit 1; }
FILES=(
  frontend/src/app/kiosk/page.js
  frontend/src/lib/voziaBridge.js
  frontend/src/locales/en.json
  frontend/src/locales/es.json
  frontend/test/vozia-bridge.test.js
  .deploy-notes/2026-09-03-ship-kiosk-remote-assist-f0-rfm.sh
)
# Gate 1: los locales siguen CRLF y el diff es de 2 líneas cada uno
for f in frontend/src/locales/en.json frontend/src/locales/es.json; do
  n=$(git diff --numstat -- "$f" | awk '{print $1}'); [ "${n:-0}" = "2" ] || { echo "ABORT: $f añade $n líneas (esperado 2) — ¿se normalizó CRLF?"; exit 1; }
done
# Gate 2: cero backend en el diff
if git diff --name-only | grep -q '^backend/'; then echo "ABORT: el diff toca backend/"; exit 1; fi
# Gate 3: tests + build
export PATH=/usr/local/Cellar/node@22/22.23.2_1/bin:$PATH
( cd frontend && npx vitest run test/vozia-bridge.test.js && npm run build ) || { echo "ABORT: tests/build"; exit 1; }
git add -- "${FILES[@]}"
git commit -m "feat(kiosk): honest flow_completed — never show DONE unless the session actually closed (Valet remote assist F0)

- completeSession() runs FIRST with the Valet overlay mounted; on failure the kiosk stays on
  screen, keeps the conversation alive and acks {refused:true, reason} (enum-only), with a 6 s
  toast naming the pending step and ONE VOZIA_COMMAND_REFUSED event per command.
- In-flight + refused-id guards (redelivery every ~2 s can no longer storm /complete or
  eventsJson), conversation-change guard, routeFatal for device/network truth.
- kiosk-state carries kioskSessionId (KIOSK-EMBED v4, additive; ignored by Valet until F1).
- Closes G3 of doc/kiosk-valet-remote-assist-plan-2026-09-03.md. QA: SHIP.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
echo "COMMIT OK: $(git rev-parse --short HEAD) en $(git rev-parse --abbrev-ref HEAD) — siguiente: deployer push a main + deploy por sha + smoke Hector"
