#!/bin/bash
# Commit SPIN_MOCK tooling + tag v0.9.0-beta.70 + push everything.
# Run from your Mac terminal — avoids FUSE git index.lock issue.
#
# Usage:
#   bash .patches-today/commit-mock-and-tag.sh

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement
rm -f .git/index.lock

echo "=== 1/4: Stage + commit working tree ==="
git add \
  backend/src/modules/payment-gateway/spin-client.js \
  backend/scripts/local-smoke-counter-checkin.mjs \
  .deploy-notes/2026-05-22-deploy-v0.9.0-beta.70.md \
  .patches-today/local-smoke-setup.sh \
  .patches-today/dev-env-setup.sh

git commit -m "chore(round-25): SPIN_MOCK env mode + local smoke harness

Tooling commit — no production behavior change. Bundles:

backend/src/modules/payment-gateway/spin-client.js
  - Added env-gated SPIN_MOCK mode. When process.env.SPIN_MOCK === 'true'
    the spinRequest() function short-circuits before any HTTP call and
    returns fake successful responses (Sale, Auth, Capture, Void,
    TerminalStatus). For LOCAL dev only — env var is never set in prod.
  - Mock responses include SignatureData (base64 PNG) and IPosToken so
    the Round 25 orchestrator path runs end-to-end without a real
    terminal.

backend/scripts/local-smoke-counter-checkin.mjs
  - End-to-end smoke harness for runCounterCheckinFlow against the local
    Postgres. Seeds minimal test data (Vehicle, Customer, Reservation,
    ReservationCharge), calls the orchestrator with a stub storage
    (since local has no Supabase configured), then asserts the DB state
    is correct.
  - Run with: docker compose exec backend node scripts/local-smoke-counter-checkin.mjs

.deploy-notes/2026-05-22-deploy-v0.9.0-beta.70.md
  - Deploy plan for v0.9.0-beta.70 (round 25 to live).

.patches-today/
  - Helper scripts used during today's session. Kept for posterity.

Smoke result (local, SPIN_MOCK=true, 2026-05-22):
  Result: { signingId, authReferenceId, authAmountCents: 25000,
           signedFields: 8, pendingFields: 0, completed: true,
           cardLast4: '4242' }
  ReservationSigningField rows: 8 (5 with sig path, 3 with value='true')
  DejavooTransaction rows: 2 (SALE approved, AUTH approved)

No schema changes. No new migrations."

echo ""
echo "=== 2/4: Re-tag v0.9.0-beta.70 to include this new commit ==="
git tag -f -a v0.9.0-beta.70 -m "v0.9.0-beta.70: round 25 — Sale-driven Dejavoo flow + 9 hotfixes + smoke harness"

echo ""
echo "=== 3/4: Push commit ==="
git push origin main

echo ""
echo "=== 4/4: Force-push tag (overwrites the earlier tag at b45f3a3 prev location) ==="
git push -f origin v0.9.0-beta.70

echo ""
echo "=== Last 5 commits ==="
git log --oneline -5
echo ""
echo "Done. Ready for droplet deploy."
