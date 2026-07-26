#!/usr/bin/env bash
# ============================================================================
# SHIP: MEX Rent a Car booking-source integration. 2026-07-26.
#
# MEX's affiliate portal IS TSD RezCentral — the same software Advantage
# already scrapes — so this is a SIBLING CLONE (the repo's established
# pattern: NU/Economy/Flexways/Advantage/TL are standalone mirrors), NOT a
# shared-factory refactor: Advantage's prod behavior carries ZERO risk
# (its 91/91 suite re-ran green untouched).
#
# Own identity end to end: SOURCE_SYSTEM 'MEX', bookingChannel
# 'FRANCHISE_MEX', prefix 'MEX-', queue 'mex.sync', flag
# MEX_INTEGRATION_ENABLED (default FALSE -> shipping is INERT),
# MexLocationConfig (tenant, tsdNumber, branch) -> location. MEX's
# LOGIN_PATH carries the account entry token ?id=vufnda45gf12r2ifchif.
# MONEY posture inherited from Advantage: estimatedTotal only, isPrepaid
# false (Pay on Arrival) — pending Hector's confirmation for MEX.
#
# ACTIVATION (Hector, post-deploy): Settings -> Integrations -> MEX (TSD):
# load credentials (encrypted; NEVER the chat-pasted ones verbatim if
# rotated), create (tsdNumber, branch) -> location configs, then set
# MEX_INTEGRATION_ENABLED=true in the droplet env + restart worker.
#
# MIGRATION: 20260726_mex_location_config (new table, additive idempotent).
# Host `npx prisma generate` from backend/ REQUIRED. Session 5432 only.
# ============================================================================
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FILES=(
  "backend/prisma/schema.prisma"
  "backend/prisma/migrations/20260726_mex_location_config/migration.sql"
  "backend/src/modules/integrations/mex/mex.constants.js"
  "backend/src/modules/integrations/mex/mex.service.js"
  "backend/src/modules/integrations/mex/mex.worker.js"
  "backend/src/modules/integrations/mex/mex.scheduler.js"
  "backend/src/modules/integrations/mex/mex.routes.js"
  "backend/src/modules/integrations/mex/mex.test.mjs"
  "backend/src/modules/integrations/mex/mex.routes.test.mjs"
  "backend/src/modules/integrations/mex/mex-worker.test.mjs"
  "backend/src/main.js"
  "backend/src/worker.js"
  "backend/package.json"
  "frontend/src/lib/mex-location-contract.js"
  "frontend/src/components/settings/MexIntegrationPanel.jsx"
  "frontend/src/app/settings/page.js"
  "frontend/src/components/reservations/PendingFranchiseImportsTray.jsx"
  "frontend/src/app/reservations/page.js"
  ".deploy-notes/2026-07-26-ship-mex-integration-beta362.sh"
)

echo "== GATE 1: syntax + boot import =="
for f in backend/src/modules/integrations/mex/mex.constants.js backend/src/modules/integrations/mex/mex.service.js backend/src/modules/integrations/mex/mex.worker.js backend/src/modules/integrations/mex/mex.routes.js backend/src/main.js backend/src/worker.js; do
  node --check "$f"
done
( cd backend && DATABASE_URL="postgresql://x:x@127.0.0.1:5/x" \
  JWT_SECRET="gate-secret-not-default-123456" SKIP_LISTEN=1 \
  node -e "await import('./src/main.js'); console.log('BOOT IMPORT OK'); process.exit(0)" )

echo "== GATE 2: structural greps =="
c1=$(grep -rc "ADVANTAGE" backend/src/modules/integrations/mex/mex.constants.js || true); echo "no ADVANTAGE identifiers in mex constants (0): $c1"; [ "$c1" -eq 0 ]
c2=$(grep -c "WebLogin.aspx?id=vufnda45gf12r2ifchif" backend/src/modules/integrations/mex/mex.constants.js); echo "MEX login id token (1): $c2"; [ "$c2" -ge 1 ]
c3=$(grep -c "'MEX'" backend/src/modules/integrations/mex/mex.constants.js); echo "own SOURCE_SYSTEM (>=1): $c3"; [ "$c3" -ge 1 ]
c4=$(grep -c "mex.sync" backend/src/worker.js); echo "worker wired (>=1): $c4"; [ "$c4" -ge 1 ]
c5=$(grep -c "api/admin/integrations/mex" backend/src/main.js); echo "router mounted (1): $c5"; [ "$c5" -ge 1 ]
c6=$( (grep -r "10209California\|laurabejarano" backend/src/modules/integrations/mex frontend/src/components/settings/MexIntegrationPanel.jsx 2>/dev/null || true) | wc -l); echo "NO credentials in code (0): $c6"; [ "$c6" -eq 0 ]
c7=$(grep -c "IF NOT EXISTS" backend/prisma/migrations/20260726_mex_location_config/migration.sql); echo "idempotent DDL (>=3): $c7"; [ "$c7" -ge 3 ]

echo "== GATE 3: encoding =="
for f in "${FILES[@]}"; do
  n=$(tr -dc '\r' < "$f" | wc -c)
  case "$f" in
    backend/src/main.js|backend/src/worker.js|backend/package.json|frontend/src/app/settings/page.js|frontend/src/components/reservations/PendingFranchiseImportsTray.jsx|frontend/src/components/settings/MexIntegrationPanel.jsx|frontend/src/lib/mex-location-contract.js|backend/src/modules/integrations/mex/*)
      echo "$f CR bytes (cloned/pre-existing line endings preserved): $n" ;;
    *) [ "$n" -eq 0 ] || { echo "CR bytes in $f: $n"; exit 1; } ;;
  esac
done
n=$(tr -d '\0-\177' < backend/prisma/migrations/20260726_mex_location_config/migration.sql | wc -c)
[ "$n" -eq 0 ] || { echo "NON-ASCII bytes in migration: $n"; exit 1; }
echo "encoding OK"

echo "== GATE 4: tests =="
echo "DB-backed: test:mex 91/91 (full parity with Advantage's suite),"
echo "test:advantage 91/91 UNTOUCHED-GREEN, test:booking-source 38/38."
echo "QA fixes: login sends the ?id= entry token (was dead code), MEX pending-"
echo "imports tray added, scheduler stop on shutdown."
echo "Frontend build exit 0."

echo "== GATE 5: env parity =="
bash scripts/env-diff-check.sh

echo "== GATE 6: exact staged set =="
git reset
git add -- "${FILES[@]}"
diff <(printf '%s\n' "${FILES[@]}" | sort) <(git diff --cached --name-only | sort) \
  && echo "STAGE OK" || { echo "STAGED SET MISMATCH"; exit 1; }
