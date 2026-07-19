#!/usr/bin/env bash
# v0.9.0-beta.329 — Kiosk B3f: Get Help ↔ VozIA embed (Chloe AI + agente en vivo). SHIP DARK.
#   bash .deploy-notes/2026-07-19-ship-kiosk-vozia-gethelp-beta329.sh
#
# BACKEND + FRONTEND, SIN migración (config = AppSetting voziaKioskConfig). Pipeline:
# Innovation ×2 + Graphic Design + QA SHIP. test:kiosk 119/119 · frontend build limpio ·
# import walk OK. Contrato canónico: voice-ai-customer-service/KIOSK-EMBED.md v2 (lado
# VozIA TERMINADO; conformance byte-exacta verificada por QA).
#
# QUÉ: el botón Get Help abre el chat de VozIA en un iframe overlay (allow="camera;
# microphone") — Chloe (AI) con escalación a agente humano por chat/video (LiveKit).
# Co-presencia: cada transición del wizard postea el step al agente (enums estrictos).
# Comandos del agente al kiosk: retry/skip/restart/mensaje/flow_completed — idempotentes,
# con rechazo cortés de skips de firma/pago Y de identidad sin verify previo (el guest
# jamás queda pagado-sin-poder-firmar). Identidad de conversación memory-only, radioactiva
# (descartada al instante en reset/wipe/cierre; comandos stale descartados SIN ack). ✕ con
# confirm de dos toques cuando hay conversación (cero-persistencia del contrato = cerrar
# es colgar). Config: GET/PUT /api/kiosk/vozia-config (PUT solo ADMIN — el host recibe
# iframe con cámara/mic en el lobby), host https origin-only.
#
# ── SHIP DARK ──
# Sin voziaKioskConfig configurado, Get Help se comporta EXACTAMENTE como antes (QA
# verificó byte-idéntico). Para ENCENDER (Hector, cuando exista el hosting prod de VozIA):
#   Settings/admin → PUT vozia-config {host: "https://<vozia-host>", widgetKey: "<key>"}
#   → los kiosks lo recogen en su próximo bootstrap (GET /device). Sin re-deploy.
# E2E real pendiente de host: CORS de kiosk-state/kiosk-ack desde el origin del kiosk,
# video en iPad, co-presencia en la consola del agente. Feedback de contrato para el
# equipo VozIA: doc/kiosk-vozia-feedback-2026-07-19.md (skips de identidad se rechazan;
# sugerido ack {refused} para v3).
# NIT de QA para el backlog: end-call best-effort del shell al cerrar (hoy el backstop es
# el cierre server-side de 5 min del contrato).
#
# DEPLOY (BACKEND + FRONTEND, SIN migración):
#   git fetch --tags && git checkout v0.9.0-beta.329
#   docker compose -f docker-compose.prod.yml build backend frontend
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker frontend
#   # Post-deploy: 3 contenedores healthy + boot limpio + /health interno 200 + /kiosk 200.
#
# FILES:
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.329"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }

FILES=(
  backend/src/modules/kiosk/kiosk-device.service.js
  backend/src/modules/kiosk/kiosk-admin.routes.js
  backend/src/modules/kiosk/kiosk.test.mjs
  frontend/src/lib/voziaBridge.js
  frontend/src/components/kiosk/VoziaHelpOverlay.jsx
  frontend/src/app/kiosk/page.js
  frontend/src/app/kiosk/layout.js
  frontend/src/components/kiosk/KioskUiContext.js
  frontend/src/locales/en.json
  frontend/src/locales/es.json
  doc/kiosk-e2e-spec-2026-07-04.md
  doc/kiosk-vozia-gethelp-handoff-2026-07-19.md
  doc/kiosk-vozia-feedback-2026-07-19.md
  doc/kiosk-b5-payment-design-2026-07-16.md
  .deploy-notes/2026-07-19-ship-kiosk-vozia-gethelp-beta329.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done

git add -- "${FILES[@]}"

# GUARDS post-incidente-315: ningún hunk ajeno en archivos compartidos.
# Extrae los NOMBRES de keys añadidas (ignora la línea previa que solo gana una coma:
# aparece como -/+ del mismo contenido) y exige que toda key NUEVA sea vozia*/ok.
for LOC in frontend/src/locales/en.json frontend/src/locales/es.json; do
  FOREIGN_KEYS="$(diff <(git show HEAD:"$LOC" | grep -oE '"[A-Za-z0-9_.]+":' | sort) <(git show :"$LOC" | grep -oE '"[A-Za-z0-9_.]+":' | sort) | grep '^>' | grep -vE '"(vozia[A-Za-z]*|ok)":' || true)"
  if [ -n "$FOREIGN_KEYS" ]; then
    echo "ABORT: $LOC staged adds non-vozia keys — foreign workstream hunk:" >&2
    echo "$FOREIGN_KEYS" >&2; git reset -q; exit 1
  fi
done
if git diff --cached --name-only | grep -qE 'schema.prisma|package.json|src/main.js'; then
  echo "ABORT: shared build-critical file staged unexpectedly" >&2; git reset -q; exit 1
fi
echo "GUARDS OK"
echo "Shipping $TAG from $BRANCH"

git commit -m "feat(kiosk): B3f Get Help <-> VozIA embed — Chloe AI + live agent with co-presence (ships dark)

Get Help opens the VozIA chat in a camera/mic-enabled iframe overlay; AI
escalates to a live agent (chat/video). The shell posts co-presence on every
wizard step (strict contract enums) and applies agent commands idempotently
(retry/skip/restart/message/flow_completed) — refusing skips of signature,
payment, and unverified identity so a guest can never be stranded past the
un-forgeable /sign gate. Conversation identity is memory-only and discarded
instantly on reset/wipe/close; stale commands dropped without ack; two-tap
close confirm while a conversation is live (zero-persistence contract).
Config voziaKioskConfig per tenant (PUT admin-only, https origin-only) —
unset = byte-identical pre-B3f behavior (dark until the VozIA prod host
exists). Contract: voice-ai-customer-service/KIOSK-EMBED.md v2.

Pipeline: Innovation x2 + Graphic Design + QA SHIP.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
