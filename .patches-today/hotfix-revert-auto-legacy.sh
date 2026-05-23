#!/bin/bash
# Hotfix: revert auto-force-legacy in CheckoutSignatureStep.
# Run from your Mac terminal.
#
# Usage:
#   bash .patches-today/hotfix-revert-auto-legacy.sh

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement
rm -f .git/index.lock

echo "=== 1/4: Commit hotfix ==="
git add frontend/src/components/wizard/CheckoutSignatureStep.js

git commit -m "fix(round-25): revert auto-force-legacy in CheckoutSignatureStep

The previous logic auto-set forceLegacy=true when preflight returned
rentalFeeAmountCents=0. But preflight computes that as the sum of
ReservationCharge rows where selected=true. If charges exist but
selected is false (default state before an agent reviews them), the
result is 0 even when there IS a balance to collect.

Real-world impact: ERICK BOU (IRC ADMIN) opened a reservation that did
have a balance owed, but the wizard rendered the legacy SignaturePad
instead of the Dejavoo terminal flow because none of the charges were
marked selected=true.

Fix: stop auto-forcing legacy. The agent retains the existing 'Use
legacy signature' button for manual fallback when the terminal is
unavailable. We can revisit a smarter auto-default later (e.g. only when
rentalFeeAlreadyCollected=true AND defaultPreAuthAmountCents=0)."

echo ""
echo "=== 2/4: Re-tag v0.9.0-beta.70 ==="
git tag -f -a v0.9.0-beta.70 -m "v0.9.0-beta.70: round 25 — Sale-driven Dejavoo flow + hotfix auto-legacy revert"

echo ""
echo "=== 3/4: Push commit ==="
git push origin main

echo ""
echo "=== 4/4: Force-push tag ==="
git push -f origin v0.9.0-beta.70

echo ""
echo "=== Last 3 commits ==="
git log --oneline -3
echo ""
echo "Done. Now SSH droplet and rebuild:"
echo "  ssh root@ridefleetmanager.com"
echo "  cd ~/RideFleetManagement && git fetch --tags && git checkout v0.9.0-beta.70"
echo "  docker compose -f docker-compose.prod.yml up -d --build --force-recreate"
