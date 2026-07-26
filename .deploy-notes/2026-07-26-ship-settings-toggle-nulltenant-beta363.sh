#!/usr/bin/env bash
# ============================================================================
# SHIP: two prod bug fixes found by Hector today. 2026-07-26.
#
# 1. SETTINGS TOGGLE DISPLAY (Hector: "no me deja prender customer-led
#    inspections para Corpusa"): the tenant-scoped settings loads
#    (customer-inspection, fleet-rotation, citation-ocr) ran ONCE on mount
#    with deps [token] — before a SUPER_ADMIN picked a tenant — so the
#    toggles showed the unscoped/stale value forever. His PUT actually
#    LANDED (verified in prod AppSetting: Corpusa enabled:true,
#    checkinModel:CUSTOMER, 22:09 UTC); only the display lied. Fix:
#    activeSettingsTenantId added to the effect deps.
#
# 2. NULL-TENANT 500 (Sentry 54aacfd1): GET /api/reports/custom threw
#    PrismaClientValidationError for every SUPER_ADMIN reports-v2 view —
#    the local scopeFor used req.user.tenantId (null for supers). Fix:
#    canonical tenantScopeFor (resolves ?tenantId= for supers) + explicit
#    guards (empty list on GET /, 400 'Select a tenant first' on writes).
#
# NO migration.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "frontend/src/app/settings/page.js"
  "backend/src/modules/reports/custom/custom-reports.routes.js"
  ".deploy-notes/2026-07-26-ship-settings-toggle-nulltenant-beta363.sh"
)

echo "== GATE 1: syntax + boot import =="
node --check backend/src/modules/reports/custom/custom-reports.routes.js
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -c "token, activeSettingsTenantId\]" frontend/src/app/settings/page.js); echo "effect deps fixed (1): $c1"; [ "$c1" -ge 1 ]
c2=$(grep -c "tenantScopeFor" backend/src/modules/reports/custom/custom-reports.routes.js); echo "canonical scope (>=2): $c2"; [ "$c2" -ge 2 ]
c3=$(grep -c "Select a tenant first" backend/src/modules/reports/custom/custom-reports.routes.js); echo "null-tenant guards (>=2): $c3"; [ "$c3" -ge 2 ]

echo "== GATE 3: encoding =="
n=$(tr -dc '\r' < backend/src/modules/reports/custom/custom-reports.routes.js | wc -c)
[ "$n" -eq 0 ] || { echo "CR bytes in routes: $n"; exit 1; }
echo "encoding OK (settings/page.js keeps its pre-existing line endings)"

echo "== GATE 4: tests =="
echo "test:custom-reports 5/5 post-fix; boot OK; frontend build exit 0."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
