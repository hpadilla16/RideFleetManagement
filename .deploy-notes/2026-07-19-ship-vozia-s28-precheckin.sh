#!/usr/bin/env bash
# S28 mini W-D bis — staff-complete del pre-check-in abierto al service account
# de VozIA (el agente termina el check-in POR el cliente durante el video assist
# del kiosk).
#   S28_SHIP_TAG=v0.9.0-beta.NNN bash .deploy-notes/2026-07-19-ship-vozia-s28-precheckin.sh
#
# BACKEND ONLY, SIN migración, SIN keys nuevas.
#
# QUÉ:
#   - POST /api/reservations/:id/precheckin/staff-complete:
#     idempotency(kind:vozia-precheckin) + branch de service account —
#     author+ticketId obligatorios, EMAIL RECHAZADO (400 EMAIL_NEEDS_APPROVAL —
#     el email SOLO va por el approval flow de vozia-customer-patch), audit
#     ADMIN_OVERRIDE gana source:vozia+author+ticketId. Staff humano INTACTO
#     (canManagePrecheckin ya incluía AGENT).
#   - Allowlist: +1 entrada con su test (staff-complete allowed; /precheckin
#     del cliente, reset, nested sneaks y payments/manual siguen DENIED).
#
# DEPLOY (BACKEND ONLY):
#   git fetch --tags && git checkout $TAG
#   docker compose -f docker-compose.prod.yml build backend worker
#   docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="${S28_SHIP_TAG:?Set S28_SHIP_TAG=v0.9.0-beta.NNN before running}"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && { echo "Tag $TAG already exists" >&2; exit 1; }
git diff --cached --quiet || { echo "Index is not clean — git reset first" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"

node --check backend/src/modules/reservations/reservations.routes.js
node --check backend/src/lib/service-account-allowlist.js

export DATABASE_URL="${DATABASE_URL:-postgresql://$(whoami)@localhost:5432/fleet_management}"
( cd backend && npm run test:service-auth && npm run test:reservations )

FILES=(
  backend/src/modules/reservations/reservations.routes.js
  backend/src/lib/service-account-allowlist.js
  backend/src/lib/service-account-allowlist.test.mjs
  .deploy-notes/2026-07-19-ship-vozia-s28-precheckin.sh
)
for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "MISSING FILE: $f" >&2; exit 1; }; done
# ⚠️ reservations.routes.js es compartido — correr SOLO con diff limpio de este workstream.
git add -- "${FILES[@]}"
git status --short --branch
git commit -m "feat(reservations): S28 — precheckin staff-complete for the VozIA service account

The kiosk video-assist agent can now complete the customer's pre-check-in
from the workspace: attribution (author+ticketId) required, EMAIL rejected
with 400 EMAIL_NEEDS_APPROVAL (email changes only via the supervisor
approval flow), idempotency kind vozia-precheckin, audit ADMIN_OVERRIDE
carries source:vozia. Human staff path untouched. Allowlist +1 with tests
(customer-side precheckin routes and payment aliases stay denied).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git tag "$TAG"
echo "Committed + tagged $TAG."
