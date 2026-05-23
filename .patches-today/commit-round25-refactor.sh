#!/bin/bash
# Commit round-25 Sale-driven refactor (c24ab57 mirror).
# Run from your Mac terminal — avoids FUSE git index.lock issue.
#
# Usage:
#   bash .patches-today/commit-round25-refactor.sh

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement
rm -f .git/index.lock

git add \
  backend/src/modules/payment-gateway/counter-orchestrator.service.js \
  backend/src/modules/payment-gateway/counter-orchestrator.service.test.mjs \
  backend/src/modules/payment-gateway/counter-return-orchestrator.service.js \
  backend/src/modules/payment-gateway/spin-client.extensions.test.mjs \
  backend/src/modules/payment-gateway/spin-client.js

git commit -m "feat(round-25): Sale-driven Dejavoo flow + spin-client cleanup

The big half of round 25 (25e + 25f + 25g): replace the standalone
interactive SPIn endpoints with the Sale-driven flow that the Dejavoo
SPIn REST API actually supports.

Root cause (from last night's live smoke test):
  POST api.spinpos.net/v2/Payment/Disclaimer    → 404
  POST api.spinpos.net/v2/Payment/GetSignature  → 404
  POST api.spinpos.net/v2/Payment/UserChoice    → 404
  POST api.spinpos.net/v2/Payment/UserInput     → 404
  POST api.spinpos.net/v2/Payment/Cart          → 404

These methods do not exist as standalone endpoints. SPIn handles the
interactive flow INSIDE the Sale request — the disclaimer page is
configured on the terminal profile via the iPOSpays merchant portal,
and the signature is captured by the Sale itself when CaptureSignature
is true.

Changes:

backend/src/modules/payment-gateway/spin-client.js
  - Removed disclaimer(), getSignature(), userChoice(), userInput(),
    cart() methods.
  - Replaced with an explanatory comment block.
  - htmlToTerminalText() and extractContextAroundMarker() helpers
    retained — orphan now, but harmless and useful for the future
    tablet-based signing UX.

backend/src/modules/payment-gateway/counter-orchestrator.service.js
  - Removed captureInitialOrSignature(), captureChoice(), captureText()
    per-field handlers (lines 154-343 in v0.9.0-beta.69).
  - Removed step 5 (full T&C disclaimer call) and step 6 (per-field
    iteration loop).
  - Removed isValidIsoDate() helper (only used by captureText).
  - Added step 7d: persist one ReservationSigningField per required
    TermsTemplateField after the Sale + Auth succeed. INITIAL /
    SIGNATURE fields carry the signature path; CHECKBOX / TEXT_FIELD /
    DATE fields are marked value='true' to represent acceptance via
    the bundled signing.
  - Sale step now extracts SignatureData from the autoRentalSale
    response (CaptureSignature: true was already set) and uploads
    once to Storage.
  - Auth step now has a fallback signature extraction for the
    rentalFee == 0 case (autoRentalAuth captures the sig instead).

backend/src/modules/payment-gateway/counter-return-orchestrator.service.js
  - Removed the optional spin.cart() display call (step 6). Cart items
    flow inline in autoRentalCapture / autoRentalSale / saleWithToken
    bodies via Level3 envelopes already.

backend/src/modules/payment-gateway/counter-orchestrator.service.test.mjs
  - Updated end-to-end test for Sale-driven flow: assert SALE + AUTH
    tx types (not DISCLAIMER / GET_SIGNATURE / USER_CHOICE / USER_INPUT),
    single signature blob shared across all 5 ReservationSigningField
    rows.
  - Removed: DATE invalid input test (no longer applies).
  - Removed: isValidIsoDate test (helper deleted).
  - Updated spin stub autoRentalSale + autoRentalAuth to return
    SignatureData (matching real terminal behavior).

backend/src/modules/payment-gateway/spin-client.extensions.test.mjs
  - Removed 9 tests for the 5 deleted methods.
  - Kept tests for autoRentalSale / Auth / Capture, saleWithToken /
    authWithToken, buildLevel3FromReservation, htmlToTerminalText,
    extractContextAroundMarker.

Net diff: -518 / +223 (295 lines removed).

Tests (full payment-gateway suite):
  counter-checkin.worker:           4/4
  counter-orchestrator.service:    24/24 (was 26 - 2 removed)
  counter-return-orchestrator:     22/22
  counter-return.worker:            5/5
  spin-client:                      5/5
  spin-client.extensions:          11/11 (was 20 - 9 removed)
  card-on-file:                     4/4
  evidence-pack.service:            5/5
  pre-auth-release.scheduler:       6/6
  TOTAL: 86/86

No schema changes. No new migrations. Frontend untouched (terminal
flow renders the same progress UI; what changed is what the orchestrator
calls under the hood).

Next: local smoke test against a sandbox Dejavoo terminal, then deploy
as v0.9.0-beta.70.

Companion: doc/round-25-plan-2026-05-22.md"

echo ""
echo "=== Last 4 commits ==="
git log --oneline -4
echo ""
echo "Done."
