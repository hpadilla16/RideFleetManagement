#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# beta.377 — VozIA puede emailear la COPIA DEL AGREEMENT + fix de audit label
# (2026-08-03, QA SHIP tras 1 ronda FIX-FIRST: CRLF + whitelist de contenido)
#
# QUÉ SHIPEA (backend only, SIN migración, SIN env keys nuevas):
#   1. POST /api/rental-agreements/:id/email-agreement entra al allowlist de
#      service accounts. La rama de servicio: author+ticketId obligatorios
#      (checkServiceAccountAgreementEmail, pura), req.body REEMPLAZADO por
#      whitelist {author, ticketId} — subject/html/text jamás llegan al mailer
#      (un `delete to` solo dejaba phishing brandeado con el PDF real adjunto),
#      cooldown 60s por agreement (makeSendCooldown, pura, 429), audit row
#      {source:'vozia', kind:'agreement_email'}. Camino humano INTACTO.
#   2. BUGFIX: send-request-email etiquetaba TODO link de VozIA como
#      'payment_link' en el audit (escribía antes de mirar el kind). Ahora:
#      payment_link | signature_link | precheckin_link.
#
# NOTA DE ÁRBOL: este commit se cortó en un WORKTREE limpio desde 188e151
# porque el árbol principal carga ediciones sin commitear de OTRA sesión en
# rental-agreements.routes.js (retiro de rutas /delete). Esa sesión debe
# rebasear al reconciliar — los hunks no se pisan (regiones distintas).
#
# GATES CORRIDOS (verificados por QA):
#   allowlist 22/22 · money-route-gate 16/16 · guards 21/21 ·
#   test:rental-agreements 43/43 (postgres local)
#
# DEPLOY (Hector o agente deployer):
#   bash scripts/env-diff-check.sh   # (sin keys nuevas — debe pasar igual)
#   ssh droplet: git fetch --tags && git checkout v0.9.0-beta.377 \
#     && docker compose -f docker-compose.prod.yml build backend worker \
#     && docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
#   Verificar: 3 contenedores healthy, boot limpio, /api/health 200, y
#   grep DENTRO del contenedor (lección beta.344/345):
#     docker exec fleet-backend-prod grep -c "email-agreement" /app/src/lib/service-account-allowlist.js
#
# FILES (los 6, ya commiteados — lista para auditoría):
FILES=(
  "backend/src/lib/service-account-allowlist.js"
  "backend/src/lib/service-account-allowlist.test.mjs"
  "backend/src/modules/rental-agreements/rental-agreements.routes.js"
  "backend/src/modules/rental-agreements/service-payment-guards.js"
  "backend/src/modules/rental-agreements/service-payment-guards.test.mjs"
  "backend/src/modules/reservations/reservations.routes.js"
)
echo "Commit ya hecho en worktree — este script es el registro + receta de deploy."
