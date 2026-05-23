#!/bin/bash
# Final commit + re-tag v0.9.0-beta.70 + push (force).
# Bundles all of today's local-validation tooling + UI fixes + UX skip-balance-0.
# Run from your Mac terminal.
#
# Usage:
#   bash .patches-today/final-commit-and-tag.sh

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement
rm -f .git/index.lock

echo "=== 1/4: Stage + commit ==="
git add \
  backend/src/lib/storage/supabase-storage.js \
  backend/src/modules/payment-gateway/spin-client.js \
  backend/scripts/local-smoke-counter-checkin.mjs \
  backend/scripts/seed-ui-test-reservation.mjs \
  docker-compose.yml \
  frontend/src/app/reservations/\[id\]/checkin-wizard/page.js \
  frontend/src/app/reservations/\[id\]/checkout-wizard/page.js \
  frontend/src/components/wizard/CheckoutSignatureStep.js \
  .deploy-notes/ \
  .patches-today/

git commit -m "chore(round-25): local dev tooling + 3 UI fixes (card-on-file + skip-balance-0)

Tooling commit — env-gated production behavior change (no impact when env
vars unset) + three UI bug/UX fixes.

backend/src/modules/payment-gateway/spin-client.js
  - Added env-gated SPIN_MOCK mode. When process.env.SPIN_MOCK === 'true'
    spinRequest() short-circuits and returns fake successful responses
    (Sale, Auth, Capture, Void, TerminalStatus). For LOCAL dev only.

backend/src/lib/storage/supabase-storage.js
  - Added env-gated STORAGE_MOCK mode for uploadObject(). When set, returns
    a fake path without hitting Supabase. Resilient to Supabase outages.

docker-compose.yml (dev)
  - Added redis + worker services so the full local pipeline runs.
    Without Redis, POST /counter/start-checkin hung on BullMQ enqueue.
    Backend container REDIS_URL=redis://redis:6379 override.

frontend/src/app/reservations/[id]/checkin-wizard/page.js
frontend/src/app/reservations/[id]/checkout-wizard/page.js
  - UI fix #1: 'Card on file' now reads dejavooCardLast4 / dejavooCardBrand
    first, falling back to legacy cardLast4 / cardBrand. Round 20 introduced
    the dejavoo* fields but the wizard summary still read the legacy
    AuthNet ones, so after a SALE saved the IPosToken it kept showing
    '- No card'.

frontend/src/app/reservations/[id]/checkin-wizard/page.js (onNext)
  - UX #1: when totalOwed (feePreview.total + agreement.balance) is 0 on
    Continue from step 2 (Metrics), skip steps 3 (Payment choice) and 4
    (Acknowledge fees) and go directly to submitCheckinClose (which voids
    the hold + marks return complete). Saves the agent two unnecessary
    Dejavoo prompts when there's nothing to charge at return. Inspection
    (steps 0-2) still runs every time.

frontend/src/components/wizard/CheckoutSignatureStep.js
  - UX #2: when preflight returns rentalFeeAmountCents=0 (rental was
    prepaid online), auto-default to legacy SignaturePad mode instead of
    the Dejavoo terminal flow. The customer still signs the T&C and then
    moves to vehicle inspection — but the terminal isn't prompted because
    there's no SALE to process. Agent can still manually override either
    direction via the existing 'Use legacy signature' link.

backend/scripts/local-smoke-counter-checkin.mjs
backend/scripts/seed-ui-test-reservation.mjs
  - End-to-end smoke harness + test data seed. Validates the orchestrator
    pipeline against local Postgres with stub storage.

.deploy-notes/2026-05-22-deploy-v0.9.0-beta.70.md
.deploy-notes/2026-05-22-flip-jose-tenantid-null.sql
  - Deploy plan + SQL artifacts from today's session.

.patches-today/
  - Helper scripts used during this session — commit helpers,
    local-smoke-setup.sh, full-local-rebuild.sh. Kept for posterity.

Local validation (2026-05-22):
  Checkout wizard (pickup, balance=225):
    SALE \$225 + AUTH \$250 card-on-file CNP
    8 ReservationSigningField rows persisted, wizard advanced to success.
  Checkout wizard (pickup, balance=0 prepaid):
    Auto-defaults to legacy SignaturePad, no Dejavoo prompt, inspection runs.
  Checkin wizard (return, CASE A — extras > 0):
    CAPTURE \$25 from prior \$250 hold, wizard advances through payment.
  Checkin wizard (return, balance=0):
    Skip Payment choice + Acknowledge fees, go directly to Return complete.

Backend tests still passing: 86/86 across payment-gateway module.
No schema changes. No new migrations.

Companion: doc/round-25-plan-2026-05-22.md
Deploy plan: .deploy-notes/2026-05-22-deploy-v0.9.0-beta.70.md"

echo ""
echo "=== 2/4: Re-tag v0.9.0-beta.70 ==="
git tag -f -a v0.9.0-beta.70 -m "v0.9.0-beta.70: round 25 — Sale-driven Dejavoo flow + 9 hotfixes + tooling + 3 UI fixes"

echo ""
echo "=== 3/4: Push commit ==="
git push origin main

echo ""
echo "=== 4/4: Force-push tag ==="
git push -f origin v0.9.0-beta.70

echo ""
echo "=== Last 5 commits ==="
git log --oneline -5
echo ""
echo "Done. Ready for tonight's deploy."
echo "Reference: .deploy-notes/2026-05-22-deploy-v0.9.0-beta.70.md"
