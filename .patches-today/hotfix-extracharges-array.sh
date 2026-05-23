#!/bin/bash
# Hotfix: AutoRentalPricing.ExtraCharges must be [""] not []
# Root cause confirmed via rawResponse capture:
#   "Invalid request data : ExtraCharges are required or NoExtraCharge
#    cannot be combined with other charges"

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement
rm -f .git/index.lock

echo "=== 1/4: Commit ==="
git add backend/src/modules/payment-gateway/spin-client.js

git commit -m "fix(round-25): AutoRentalPricing.ExtraCharges needs [''] not []

SPIn proxy rejected our request with StatusCode 2201 / DetailedMessage:
'Invalid request data : ExtraCharges are required or NoExtraCharge
cannot be combined with other charges'.

We sent ExtraCharges: [] (empty array). The docs sample shows
ExtraCharges: [''] (array with one empty string as a placeholder for
'no extras'). Fix: match the docs.

This is the third 2201 we hit:
  1st: 'RentalData' wrapper instead of 'AutoRental'        → fixed cc4efdd
  2nd: flat AutoRental object instead of nested            → fixed 02af640
  3rd: empty ExtraCharges array                            → fixed here

Tests still 11/11."

echo ""
echo "=== 2/4: Re-tag v0.9.0-beta.70 ==="
git tag -f -a v0.9.0-beta.70 -m "v0.9.0-beta.70: round 25 — Sale-driven Dejavoo flow + AutoRental wrapper + nested schema + ExtraCharges fix"

echo ""
echo "=== 3/4: Push ==="
git push origin main

echo ""
echo "=== 4/4: Force-push tag ==="
git push -f origin v0.9.0-beta.70

git log --oneline -5
echo ""
echo "Then on droplet:"
echo "  cd ~/RideFleetManagement && git fetch --tags --force && git checkout v0.9.0-beta.70"
echo "  docker compose -f docker-compose.prod.yml build --no-cache backend worker"
echo "  docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker"
