#!/bin/bash
# Commit the round-25 prep changes from your Mac terminal.
# Run from: /Users/hectorpadilla/Code/RideFleetManagement
#
# Usage:
#   bash .patches-today/commit-round25-prep.sh
#
# This avoids the FUSE-mount git index.lock issue that the sandbox hits.

set -e

cd /Users/hectorpadilla/Code/RideFleetManagement

# Just in case the lock came back.
rm -f .git/index.lock

git add \
  backend/prisma/schema.prisma \
  backend/prisma/migrations/20260522_round25_prep/ \
  backend/src/modules/payment-gateway/counter-return-orchestrator.service.js \
  backend/src/modules/payment-gateway/counter.routes.js \
  .deploy-notes/ \
  doc/round-25-plan-2026-05-22.md

git commit -m "fix(round-25-prep): repo/DB drift sync from 2026-05-21 live hotfixes

Three small fixes that were applied live to production during the
v0.9.0-beta.69 smoke test (and then rolled back to v0.9.0-beta.56)
but never made it into the repo. Round 25 builds on top of these.

- backend/prisma/schema.prisma: add Tenant.settingsJson (JSONB) for
  per-tenant operational settings (Dejavoo preAuthAmountCents, etc.).
- backend/src/modules/payment-gateway/counter.routes.js: preflight
  selects ReservationCharge.name (was .label which does not exist).
- backend/src/modules/payment-gateway/counter-return-orchestrator.service.js:
  wrap String() around statusCode before persisting to DejavooTransaction
  (spinStatusCode is Int from SPIn, column is String?).

Also bundles the operator workflow notes:

- backend/prisma/migrations/20260522_round25_prep/migration.sql:
  idempotent migration that backfills the Tenant.settingsJson column
  and updates FeeRate_feeType_check (add LATE_RETURN) +
  FeeRate_unit_check (add PER_HOUR) live constraints.
- doc/round-25-plan-2026-05-22.md: full round 25 plan + bug inventory.
- .deploy-notes/2026-05-22-create-second-super-admin.sql: SQL we ran
  this morning to promote jcdiaz@internationalrentalcorp.com to
  SUPER_ADMIN (keeping tenantId=IRC to avoid empty feature-flags bug).

Tests:
- counter-checkin.worker: 4/4
- counter-orchestrator.service: 26/26
- counter-return-orchestrator.service: 22/22
- counter-return.worker: 5/5

Companion: doc/round-25-plan-2026-05-22.md"

echo ""
echo "=== Last commit ==="
git log --oneline -2
echo ""
echo "Done. Push with 'git push origin main' when ready."
