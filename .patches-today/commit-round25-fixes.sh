#!/bin/bash
# Commit round-25 SUPER_ADMIN scoping + hotfixes (8f5b101 mirror).
# Run from your Mac terminal — avoids FUSE git index.lock issue.
#
# Usage:
#   bash .patches-today/commit-round25-fixes.sh

set -e

cd /Users/hectorpadilla/Code/RideFleetManagement

rm -f .git/index.lock

git add \
  backend/src/modules/admin/tenant-flags.routes.js \
  backend/src/modules/integrations/tl-international/tl-international.routes.js \
  backend/src/modules/payment-gateway/counter-orchestrator.service.js \
  backend/src/modules/reports/reports-v2.routes.js \
  backend/src/modules/wizard-state/wizard-state.routes.js \
  frontend/src/app/reservations/[id]/checkin-wizard/page.js \
  frontend/src/components/wizard/CheckinPaymentStep.js \
  frontend/src/components/wizard/CheckoutSignatureStep.js \
  frontend/src/hooks/useFeatureFlags.js \
  .deploy-notes/2026-05-22-flip-jose-tenantid-null.sql

git commit -m "fix(round-25): SUPER_ADMIN scoping + 5 hotfixes

This is the first half of round 25 (the small-but-blocking fixes).
The big counter orchestrator refactor lands in the next commit.

Fixes:

1. counter-orchestrator.service.js — wrap String() around statusCode in
   recordTxError. Pre-existing bug parallel to the one we fixed in
   counter-return-orchestrator in df36331. Without this, when the SPIn
   flow fails the audit row never gets persisted.

2. wizard-state.routes.js — replace local requireRole with the canonical
   import from middleware/auth.js. The local version lacked the
   SUPER_ADMIN bypass — SUPER_ADMIN users got 403s on wizard-state reads
   even when SUPER_ADMIN was listed in allowed roles (because the
   downstream service rejected req.user.tenantId=null).

3. reports-v2.routes.js — same fix as #2: import canonical requireRole.
   Per-report endpoints that don't list SUPER_ADMIN explicitly in roles
   now grant SUPER_ADMIN access via the bypass.

4. tenant-flags.routes.js — /api/me/feature-flags now accepts ?tenantId=
   query param when req.user.role === 'SUPER_ADMIN'. Previously
   SUPER_ADMIN (which has tenantId=null in JWT) short-circuited to empty
   flags, forcing operators to flip flags to LIVE just to smoke-test
   TEST-mode features.

5. tl-international.routes.js — TenantRequiredError typed class with
   status=400; asyncHandler catches it and maps to 400 instead of letting
   the generic error handler return 500. Surfaces this morning when
   Jose's SUPER_ADMIN account viewed Zezgo data without a tenantId param.

Frontend:

- useFeatureFlags hook: optional tenantId param, cache keyed by
  token+tenantId so SUPER_ADMIN can switch between tenants without stale
  state. Sends ?tenantId= when present.
- CheckoutSignatureStep: passes agreement?.tenantId to the hook.
- CheckinPaymentStep: accepts new tenantId prop, passes to the hook.
- checkin-wizard/page.js: passes reservation.tenantId to the step.

Also bundles:

- .deploy-notes/2026-05-22-flip-jose-tenantid-null.sql: SQL we ran today
  to flip the Jose Diaz second-super-admin account to tenantId=NULL.

Tests:
- counter-orchestrator.service: 26/26
- wizard-state.service: 22/22
- reports-v2.service: 8/8
- tl-international.routes: 3/3 (rest of suite hangs on pre-existing
  teardown issue, unrelated)

Companion: doc/round-25-plan-2026-05-22.md (bugs #3, #4, #5 + new #6)"

echo ""
echo "=== Last 3 commits ==="
git log --oneline -3
echo ""
echo "Done."
