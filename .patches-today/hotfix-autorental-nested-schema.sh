#!/bin/bash
# Hotfix: rewrite buildLevel3FromReservation with correct NESTED AutoRental schema
# Root cause of the HTTP 500 'An error has occurred' we hit after the
# RentalData→AutoRental wrapper fix. SPIn AutoRental requires nested
# sub-objects (AutoRentalAgreement, AutoRentalRenter, AutoRentalVehicle,
# AutoRentalPricing, AutoRentalPickup, AutoRentalReturn, AutoRentalDistance),
# not a flat object.
#
# Usage:
#   bash .patches-today/hotfix-autorental-nested-schema.sh

set -e
cd /Users/hectorpadilla/Code/RideFleetManagement
rm -f .git/index.lock

echo "=== 1/4: Commit ==="
git add \
  backend/src/modules/payment-gateway/spin-client.js \
  backend/src/modules/payment-gateway/spin-client.extensions.test.mjs

git commit -m "fix(round-25): nested AutoRental schema per SPIn docs

After the RentalData->AutoRental wrapper fix (commit cc4efdd) the live
terminal call moved from StatusCode 2201 / ResultCode 2 to HTTP 500 with
generic ASP.NET 'An error has occurred' message. Reason: our
buildLevel3FromReservation produced a FLAT AutoRental object, but per
docs (https://app.theneo.io/dejavoo/spin/autorental/auto-rental-auth)
SPIn requires a NESTED structure with these sub-objects:

  AutoRental: {
    AutoRentalAgreement: { AgreementReferenceNumber, PurchaseIdentifier,
                           RentalDuration, RentalPeriod,
                           AutoRentalAdjustment: { AdjustmentAmount,
                                                   AdjustmentAuditIndicatorCode } }
    AutoRentalRenter:     { RenterName, ServiceMobile }
    AutoRentalVehicle:    { VehicleMake, VehicleModel, RentalClassId }
    AutoRentalPricing:    { RentalRate, ExtraCharges }
    AutoRentalPickup:     { DateTime, Address, City, State, Country,
                            LocationId, RegionCode, CountryCode }
    AutoRentalReturn:     { DateTime, Address, City, State, Country,
                            LocationId, RegionCode, CountryCode }
    AutoRentalDistance:   { RentalDistance, AutoRentalDistanceUnitofMeasure }
  }

Field mapping from our domain:
  agreement.agreementNumber || reservation.id → AgreementReferenceNumber
  agreement.totalDays                         → RentalDuration
  customer firstName+lastName                  → RenterName
  customer.phone                               → ServiceMobile
  vehicle.make / model                         → VehicleMake / VehicleModel
  vehicle.classCode || vehicleType.code        → RentalClassId
  agreement.dailyRate                          → RentalRate
  reservation.pickupAt/returnAt                → AutoRentalPickup/Return.DateTime
  Location address/city/state/code             → AutoRentalPickup/Return.*

Tests updated to assert the new nested structure.

Tests: spin-client.extensions 11/11 + counter-orchestrator 24/24 +
counter-return-orchestrator 22/22 = 57/57."

echo ""
echo "=== 2/4: Re-tag v0.9.0-beta.70 ==="
git tag -f -a v0.9.0-beta.70 -m "v0.9.0-beta.70: round 25 — Sale-driven Dejavoo flow + nested AutoRental schema fix"

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
echo "Done. Now in droplet:"
echo "  cd ~/RideFleetManagement && git fetch --tags --force && git checkout v0.9.0-beta.70"
echo "  docker compose -f docker-compose.prod.yml build --no-cache backend worker"
echo "  docker compose -f docker-compose.prod.yml up -d --force-recreate backend worker"
