#!/bin/bash
# Hotfix: SPIn AutoRental body field name (RentalData → AutoRental) + persist
# rawResponse in recordTxError.
# Root cause of the StatusCode 2201 / ResultCode 2 error from prod smoke test.
#
# Usage:
#   bash .patches-today/hotfix-autorental-field-name.sh

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement
rm -f .git/index.lock

echo "=== 1/4: Commit hotfix ==="
git add \
  backend/src/modules/payment-gateway/spin-client.js \
  backend/src/modules/payment-gateway/counter-orchestrator.service.js \
  backend/src/modules/payment-gateway/counter-return-orchestrator.service.js \
  backend/src/modules/payment-gateway/spin-client.extensions.test.mjs

git commit -m "fix(round-25): SPIn AutoRental body wrapper RentalData -> AutoRental

Root cause of the StatusCode 2201 / ResultCode 2 we hit in prod smoke
test. SPIn proxy was rejecting the request before it ever reached the
terminal (232ms response time, ResultCode 2 = SPIN proxy error).

Per the SPIn REST API docs
(https://app.theneo.io/dejavoo/spin/autorental/auto-rental-auth) the
AutoRental endpoints require the body to include an 'AutoRental' object
as a required field — alongside Amount, PaymentType, and ReferenceId.
Our spin-client was wrapping the rental fields in a 'RentalData' key
which the proxy treats as an unknown/missing required field.

Affected methods (all four already pointing at /v2/AutoRental/*):
  - autoRentalSale
  - autoRentalAuth
  - autoRentalCapture
  - authWithToken

Also improves error visibility:
  - counter-orchestrator.service.js recordTxError now persists the
    rawResponse from err.spinResponse. Without this, when SPIn rejected
    with StatusCode 2201 we had no AutoRentalValidationError details
    in the DejavooTransaction audit row — only 'Error'.
  - counter-return-orchestrator.service.js recordTxError same fix.

Tests updated to match new body shape:
  - spin-client.extensions.test.mjs autoRentalSale + autoRentalAuth
    assertions now check lastRequest.body.AutoRental (was RentalData).

Tests:
  spin-client.extensions: 11/11
  counter-orchestrator.service: 24/24
  counter-return-orchestrator.service: 22/22
  counter-checkin.worker: 4/4
  spin-client: 5/5
  TOTAL: 66/66 across payment-gateway

No schema changes. No new migrations. The Level3 + Cart envelopes are
unchanged — only the AutoRental-specific RentalData wrapper key name."

echo ""
echo "=== 2/4: Re-tag v0.9.0-beta.70 ==="
git tag -f -a v0.9.0-beta.70 -m "v0.9.0-beta.70: round 25 — Sale-driven Dejavoo flow + AutoRental wrapper hotfix"

echo ""
echo "=== 3/4: Push commit ==="
git push origin main

echo ""
echo "=== 4/4: Force-push tag ==="
git push -f origin v0.9.0-beta.70

echo ""
echo "=== Last 4 commits ==="
git log --oneline -4
echo ""
echo "Done. Now SSH droplet and rebuild:"
echo "  ssh root@ridefleetmanager.com"
echo "  cd ~/RideFleetManagement && git fetch --tags --force && git checkout v0.9.0-beta.70"
echo "  docker compose -f docker-compose.prod.yml build --no-cache backend worker"
echo "  docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker"
