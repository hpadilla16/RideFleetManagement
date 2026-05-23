#!/bin/bash
# Hotfix #4: Cart.Amounts array + Items[].Price + ExtraCharges 'NoExtraCharge' enum.
# Three validations from the latest rawResponse:
#   - "Unacceptable value for AutoRental.AutoRentalPricing.ExtraCharges[0]"
#   - "List of Amounts required in Cart"
#   - "Price field is required for Items in Cart's Items List"

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement
rm -f .git/index.lock

echo "=== 1/4: Commit ==="
git add backend/src/modules/payment-gateway/spin-client.js

git commit -m "fix(round-25): Cart.Amounts + Items[].Price + ExtraCharges enum

After the third 2201 round-trip the rawResponse now lists THREE
validation errors at once (helpful):

  'Unacceptable value for AutoRental.AutoRentalPricing.ExtraCharges[0]'
  'List of Amounts required in Cart and it must contain at least one Amount'
  'Price field is required for Items in Cart's Items List'

Fixes in buildLevel3FromReservation:

1. Cart.Items[].Price — added alongside existing Total/UnitPrice/Quantity
   so the items satisfy the new required field.

2. Cart.Amounts — added an Amounts array with Subtotal + Total entries
   so the cart isn't 'missing the list of Amounts'.

3. ExtraCharges — switched from ['' ] to ['NoExtraCharge']. The error
   message itself told us 'NoExtraCharge cannot be combined with other
   charges' — implying NoExtraCharge IS a valid enum value, just not
   compatible with non-empty ExtraCharges arrays.

This is the 4th 2201 chase. Track record:
  cc4efdd: RentalData -> AutoRental wrapper       (fixed parser)
  02af640: flat AutoRental -> nested              (fixed schema)
  XXXXXXX: this one — Cart + ExtraCharges shape   (fixed validation)

Tests: spin-client.extensions 11/11.

No schema changes. No new migrations."

echo ""
echo "=== 2/4: Re-tag v0.9.0-beta.70 ==="
git tag -f -a v0.9.0-beta.70 -m "v0.9.0-beta.70: round 25 — Sale-driven Dejavoo flow + AutoRental schema fix + Cart schema fix"

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
