#!/usr/bin/env bash
# v0.9.0-beta.134 — Dashboard SIPP picker (Settings → Market Intelligence).
#   bash .deploy-notes/2026-06-08-ship-dashboard-sipp-picker-beta134.sh
#
# Has an ADDITIVE migration (one nullable JSON column). No money/gateway code.
#
# WHAT: a tenant can pin up to 6 SIPP codes to their Market Intelligence dashboard
# card (Settings → Market Intelligence). Empty → card keeps the top-6-by-volume
# default. Closes the beta.131 follow-up ("en settings agregar opción para que el
# tenant escoja 6 SIPPs del dashboard").
#
# FILES:
#   backend/prisma/schema.prisma                                  Tenant.dashboardSipps Json?
#   backend/prisma/migrations/20260608_tenant_dashboard_sipps/    ADD COLUMN dashboardSipps JSONB
#   backend/src/modules/settings/settings.service.js              get/updateDashboardSipps (+ SIPP whitelist)
#   backend/src/modules/settings/settings.routes.js              GET/PUT /api/settings/dashboard-sipps (ADMIN)
#   backend/src/modules/market-observations/market-observations.service.js  summary returns preferredSipps
#   frontend/src/components/MarketIntelligenceCard.jsx           selectDashboardSipps (preferred → fallback top6)
#   frontend/src/app/settings/page.js                            new "Market Intelligence" tab + picker UI
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"
BRANCH="$(git branch --show-current)"; TAG="v0.9.0-beta.134"
[ -n "$BRANCH" ] || { echo "Detached HEAD — checkout release/deposit-balance-fix-beta119 first" >&2; exit 1; }
echo "Shipping $TAG from branch: $BRANCH (must be at v0.9.0-beta.133 tip)"
[ -f .git/index.lock ] && ! pgrep -x git >/dev/null 2>&1 && rm -f .git/index.lock || true

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260608_tenant_dashboard_sipps/migration.sql"
  "backend/src/modules/settings/settings.service.js"
  "backend/src/modules/settings/settings.routes.js"
  "backend/src/modules/market-observations/market-observations.service.js"
  "frontend/src/components/MarketIntelligenceCard.jsx"
  "frontend/src/app/settings/page.js"
  ".deploy-notes/2026-06-08-ship-dashboard-sipp-picker-beta134.sh"
)

# ── SYNTAX GATE: backend via node --check; frontend (jsx) validated by the docker
#    build (force-recreate below) — both parse clean with @babel/parser in prep.
( cd backend \
  && node --check src/modules/settings/settings.service.js \
  && node --check src/modules/settings/settings.routes.js \
  && node --check src/modules/market-observations/market-observations.service.js )
echo "node --check OK."

# ── PRISMA: schema must validate (catches a bad column before migrate).
( cd backend && npx prisma validate >/dev/null ) && echo "prisma validate OK."

# ── GUARDS: confirm the wiring is present end-to-end.
grep -nq "dashboardSipps" backend/prisma/schema.prisma || { echo "ABORT: schema missing dashboardSipps." >&2; exit 1; }
grep -nq "updateDashboardSipps" backend/src/modules/settings/settings.service.js || { echo "ABORT: service missing updateDashboardSipps." >&2; exit 1; }
grep -nq "dashboard-sipps" backend/src/modules/settings/settings.routes.js || { echo "ABORT: route missing." >&2; exit 1; }
grep -nq "preferredSipps" backend/src/modules/market-observations/market-observations.service.js || { echo "ABORT: market summary missing preferredSipps." >&2; exit 1; }
grep -nq "selectDashboardSipps" frontend/src/components/MarketIntelligenceCard.jsx || { echo "ABORT: card missing selectDashboardSipps." >&2; exit 1; }
grep -nq "marketIntel" frontend/src/app/settings/page.js || { echo "ABORT: settings tab missing." >&2; exit 1; }
echo "Guards OK."

bash scripts/env-diff-check.sh || { echo "env-diff-check failed — resolve before deploy." >&2; exit 1; }

git add -- "${FILES[@]}"; echo; git status --short -- "${FILES[@]}"; echo
echo "Review:  git diff --cached -- ${FILES[*]}"; echo
read -r -p "Commit + tag $TAG + push? [y/N] " ok
[ "$ok" = "y" ] || { echo "Left staged (not committed). To unstage: git restore --staged ${FILES[*]}"; exit 0; }
git commit -m "feat(market-intel): dashboard SIPP picker in Settings

Tenants can pin up to 6 SIPP codes to their Market Intelligence dashboard card
(Settings → Market Intelligence). Empty → card keeps the top-6-by-volume default.

- schema: Tenant.dashboardSipps Json? (+ additive migration, nullable JSONB).
- settings.service: get/updateDashboardSipps with a SIPP-code whitelist + 6 cap.
- settings.routes: GET/PUT /api/settings/dashboard-sipps (ADMIN, tenant-scoped).
- market-observations.service: /summary returns preferredSipps.
- MarketIntelligenceCard: selectDashboardSipps (tenant pins → fallback top 6).
- settings page: new Market Intelligence tab with the picker.
No money/gateway code. Additive migration only."
git tag "$TAG"; git push origin "$BRANCH" "$TAG"
echo
echo "Pushed $TAG. On the droplet:"
echo "  git fetch --tags && git checkout $TAG \\"
echo "    && docker compose -f docker-compose.prod.yml build \\"
echo "    && docker compose -f docker-compose.prod.yml up -d --force-recreate"
echo
echo "  # MIGRATION (additive) — run via the SESSION port 5432, never pgbouncer 6543:"
echo "  docker exec fleet-backend-prod sh -c 'export DATABASE_URL=\$(echo \"\$DATABASE_URL\" | sed -e \"s/:6543/:5432/\" -e \"s/[?&]pgbouncer=true//\"); npx prisma migrate deploy'"
echo
echo "VERIFY: 4 containers healthy + clean boot + /health 200 + frontend HARD refresh."
echo "  smoke: Settings → Market Intelligence → pick up to 6 SIPPs → Save → reload the"
echo "         home dashboard card shows exactly those (in order). Clear → back to top 6."
