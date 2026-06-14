#!/usr/bin/env bash
# v0.9.0-beta.164 — CITATIONS: endpoint interno de placas activas (auto plate-list)
#   bash .deploy-notes/2026-06-14-ship-citations-plates-endpoint-beta164.sh
#
# CODE-ONLY (sin migración, sin frontend). NO money.
#
# QUÉ ENTRA (PLUG-AND-PLAY multi-tenant, gateado por settings):
#   • citations.service.js:
#       - listActivePlates(tenantId,{requireEnabled}) — placas de vehículos status
#         != SOLD (incluye OUT_OF_SERVICE/sitting), de-dup, ESTADO derivado de la
#         Location.state del home location (no hardcodeado FL). requireEnabled gatea
#         por Tenant.citationsEnabled.
#       - listPlatesForSource(source) — TODOS los tenants con CitationSourceAccount
#         activo de ese source Y citationsEnabled=true → placas agrupadas por tenant.
#   • citations.routes.js: NUEVO GET /api/internal/citations/plates
#         ?source=… (multi-tenant) | ?tenantId=… (single, respeta el toggle).
#   • tenants.service.js: wire de citationsEnabled en create + update (el toggle de
#     settings que activa/desactiva Citations por tenant).
#   • frontend tenants/page.js: checkbox "Citations Enabled" en el form de crear +
#     columna/toggle en la tabla de editar (el switch real en Settings → Tenants).
#   Resultado: onboard un tenant/location + crea su source account + activa Citations
#   en settings → entra solo al run nocturno del adapter. Cero config por-tenant en
#   el droplet, cero archivo sembrado a mano. (Adapter: ops/scraper-droplet/
#   2026-06-14-citations-cpc-plate-autolist.sh — se aplica APARTE en el droplet.)
#
# SIN MIGRACIÓN (citationsEnabled ya existe en el schema desde beta.163).
# /api/internal/citations ya está montado (beta.163) — esto solo añade una ruta GET
# al router interno existente; ningún import top-level nuevo.
#
# FILES:
#   backend/src/modules/citations/citations.service.js
#   backend/src/modules/citations/citations.routes.js
#   backend/src/modules/tenants/tenants.service.js
#   .deploy-notes/2026-06-14-ship-citations-plates-endpoint-beta164.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.164"
[ "$BRANCH" = "release/deposit-balance-fix-beta119" ] || { echo "Must be on release/deposit-balance-fix-beta119. On: $BRANCH" >&2; exit 1; }
echo "Shipping $TAG from $BRANCH"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/src/modules/citations/citations.service.js"
  "backend/src/modules/citations/citations.routes.js"
  "backend/src/modules/tenants/tenants.service.js"
  "frontend/src/app/tenants/page.js"
  ".deploy-notes/2026-06-14-ship-citations-plates-endpoint-beta164.sh"
)

# ── SYNTAX GATES (todo import top-level de main.js debe checar).
( cd backend \
  && node --check src/modules/citations/citations.service.js \
  && node --check src/modules/citations/citations.routes.js \
  && node --check src/modules/tenants/tenants.service.js \
  && node --check src/main.js \
  && node --check src/worker.js )
echo "node --check OK."

# ── GUARDS (rutas/métodos/gates presentes).
grep -nq "listActivePlates" backend/src/modules/citations/citations.service.js || { echo "ABORT: listActivePlates missing." >&2; exit 1; }
grep -nq "listPlatesForSource" backend/src/modules/citations/citations.service.js || { echo "ABORT: listPlatesForSource missing." >&2; exit 1; }
grep -nq "citationsInternalRouter.get('/plates'" backend/src/modules/citations/citations.routes.js || { echo "ABORT: /plates route missing." >&2; exit 1; }
grep -nq "requireInternalToken" backend/src/modules/citations/citations.routes.js || { echo "ABORT: internal token guard missing." >&2; exit 1; }
grep -nq "citationsEnabled" backend/src/modules/tenants/tenants.service.js || { echo "ABORT: citationsEnabled not wired in tenants.service." >&2; exit 1; }
grep -nq "Citations Enabled" frontend/src/app/tenants/page.js || { echo "ABORT: Citations toggle missing in tenants UI." >&2; exit 1; }
grep -nq "/api/internal/citations" backend/src/main.js || { echo "ABORT: internal router not mounted." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged. Unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(citations): internal active-plates endpoint for droplet adapters

- listActivePlates(tenantId): plates of non-SOLD vehicles (incl. OUT_OF_SERVICE/
  sitting — still liable for citations), de-duped, default state FL.
- GET /api/internal/citations/plates?tenantId= (BACKEND_INTERNAL_TOKEN).
- Lets the CPC/T2 droplet adapters self-sync their search set with the live fleet
  instead of a hand-seeded citations_plates.txt. Code-only, no migration, no money."
git tag "$TAG"
git push origin "$BRANCH" --tags
echo "Pushed $TAG. Deploy: BACKEND + FRONTEND build + force-recreate (frontend → hard refresh). Sin migración."
echo "Settings: Tenants → activa 'Citations' en el tenant (corpus) + crea su CitationSourceAccount para que el adapter por-source lo recoja."
echo "Verify: curl -s -H \"Authorization: Bearer \$BACKEND_INTERNAL_TOKEN\" \\"
echo "  'https://ridefleetmanager.com/api/internal/citations/plates?tenantId=cmqda70fo0004s60tbsbxbt4s' | head -c 300"
