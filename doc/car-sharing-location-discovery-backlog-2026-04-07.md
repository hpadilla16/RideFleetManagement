# Car Sharing Location Discovery Backlog

## Goal
Evolve `car sharing` from tenant-branch-based location filtering into a true marketplace discovery model where guests can search by airport, hotel, neighborhood, address, host pickup spot, or delivery area, while preserving tenant ops control and host privacy.

## Why This Matters
Today the marketplace stores host pickup spots, but the public search still filters primarily by `HostVehicleListing.locationId`. That means guest-facing discovery is still branch-centric instead of trip-centric. We need a separate search/discovery layer so the host's actual handoff options become searchable without exposing exact private details too early.

This is the gap versus Turo's public UX. Turo markets:
- search by address, airport, station, hotel, or neighborhood
- pickup vs delivery as a booking choice
- exact handoff details revealed and confirmed closer to the trip

We can surpass that by making the model more operationally explicit:
- `search place`
- `service area`
- `exact handoff point`
- tenant-side rules for visibility, approval, self-service, airport handling, and after-hours operations

## Current Constraints In Our Codebase

### Public Search
- `searchCarSharing` in `backend/src/modules/booking-engine/booking-engine.service.js` filters only by `listing.locationId`
- `book/page.js` still asks the guest for a branch-like `Preferred Location`
- `createTrip` in `backend/src/modules/car-sharing/car-sharing.service.js` falls back to `listing.locationId` for trip pickup/return ops

### Existing Host Pickup Foundation
- `HostPickupSpot` already exists
- hosts can create pickup spots in the host app and during public host onboarding
- listings can reference one `pickupSpotId`
- delivery areas are stored only as freeform strings in `deliveryAreasJson`

### Main Product Gap
- host pickup spots are metadata, not first-class discovery entities
- delivery areas are display-only, not structured service coverage
- no separate concept of exact handoff reveal vs approximate pre-booking discovery
- no geo ranking or place-type search

## Product Direction

### New Concept Split
1. `Search Place`
A public place guests can search for.
Examples:
- airport
- neighborhood
- hotel
- station
- tenant branch
- approved host pickup spot
- delivery zone

2. `Service Area`
A zone where a listing can fulfill pickup or delivery.
Examples:
- 5-mile radius around Condado
- airport parking area
- selected hotel corridor

3. `Exact Handoff Point`
The real operational handoff details used after booking.
Examples:
- exact lot/stall
- lockbox code
- street address
- smart-lock instructions

This split is the key to being better than Turo: better discovery, better privacy, better operational control.

## Recommended First-Phase Scope
1. Add structured searchable pickup/service places for car sharing
2. Search listings by place instead of only `listing.locationId`
3. Allow hosts to mark pickup spots as public-searchable or post-booking-only
4. Preserve tenant branch anchors for ops and reporting
5. Store trip fulfillment plan separately from tenant branch IDs

## File-by-File Backlog

### 1. `backend/prisma/schema.prisma`
Add:
- `CarSharingSearchPlace`
- `HostDeliveryZone` or `HostServiceArea`
- `TripFulfillmentPlan`

Suggested shape:
- `CarSharingSearchPlace`
  - `id`
  - `tenantId`
  - `hostProfileId?`
  - `hostPickupSpotId?`
  - `anchorLocationId?`
  - `placeType` (`AIRPORT`, `HOTEL`, `NEIGHBORHOOD`, `TENANT_BRANCH`, `HOST_PICKUP_SPOT`, `DELIVERY_ZONE`)
  - `label`
  - `publicLabel`
  - `city`
  - `state`
  - `postalCode`
  - `country`
  - `latitude`
  - `longitude`
  - `radiusMiles?`
  - `searchable`
  - `approvalStatus`
  - `visibilityMode` (`APPROXIMATE_ONLY`, `REVEAL_AFTER_BOOKING`, `PUBLIC_EXACT`)
  - `deliveryEligible`
  - `pickupEligible`

- `HostServiceArea`
  - `id`
  - `tenantId`
  - `hostProfileId`
  - `listingId?`
  - `searchPlaceId?`
  - `serviceType` (`PICKUP`, `DELIVERY`, `BOTH`)
  - `radiusMiles?`
  - `feeOverride?`
  - `leadTimeMinutes?`
  - `afterHoursAllowed`
  - `isActive`

- `TripFulfillmentPlan`
  - `id`
  - `tripId` unique
  - `searchPlaceId?`
  - `pickupSpotId?`
  - `serviceAreaId?`
  - `fulfillmentChoice` (`PICKUP`, `DELIVERY`)
  - `deliveryAreaChoiceLabel?`
  - `pickupRevealMode`
  - `handoffMode` (`IN_PERSON`, `LOCKBOX`, `REMOTE_UNLOCK`, `SELF_SERVICE`)
  - `exactAddress1?`
  - `exactAddress2?`
  - `city?`
  - `state?`
  - `postalCode?`
  - `latitude?`
  - `longitude?`
  - `instructions?`
  - `confirmedAt?`

Also add:
- relation fields from `HostPickupSpot`, `HostVehicleListing`, and `Trip`
- indexes by tenant, place type, searchable, host, and geo-ish fields

### 2. `backend/prisma/migrations/<car-sharing-location-discovery>`
Create migration for the new tables and enums.

Notes:
- keep it isolated from unrelated modules
- no data backfill in first migration unless simple mapping is obvious

### 3. `backend/src/modules/booking-engine/booking-engine.service.js`
Refactor `searchCarSharing`.

Current issue:
- it filters by `listing.locationId`

Change to:
- resolve search input to matching `CarSharingSearchPlace` records
- return listings that can serve that place via:
  - `listing.locationId`
  - linked `pickupSpotId`
  - linked `HostServiceArea`
- include discovery metadata in the result:
  - matched place
  - place type
  - distance/radius match when available
  - whether exact address is hidden until booking
  - available fulfillment modes for that place

Add helpers:
- `resolveCarSharingSearchPlaces(input)`
- `listSearchablePickupMatches(listing, searchPlace)`
- `listDeliveryMatches(listing, searchPlace)`
- `rankCarSharingListingsByPlaceMatch(results)`

### 4. `backend/src/modules/public-booking/public-booking.service.js`
Update public search response shape.

Add to payload:
- `searchPlaceSummary`
- `matchReason`
- `pickupChoices`
- `deliveryChoices`
- `visibilityMode`
- `handoffPreview`

Potential new endpoints:
- `GET /api/public/booking/car-sharing/places?q=`
- `GET /api/public/booking/car-sharing/place-groups`

### 5. `backend/src/modules/car-sharing/car-sharing.service.js`
Refactor `createTrip`.

Current issue:
- it still falls back to `listing.locationId`

Change to:
- create and persist a `TripFulfillmentPlan`
- keep operational branch IDs only as anchor/reporting fields
- preserve selected search place and chosen pickup/delivery mode
- store exact handoff plan separately from generic pickup location IDs

Add helpers:
- `resolveTripFulfillmentInput(data, listing)`
- `createTripFulfillmentPlan(trip, listing, input)`
- `resolveOperationalAnchorLocations(listing, fulfillmentPlan)`

### 6. `backend/src/modules/host-app/host-app.service.js`
Extend host pickup configuration.

Add support for:
- pickup spot visibility mode
- searchable toggle
- delivery-eligible toggle
- approximate label vs exact address
- optional lat/lng
- host service areas / delivery zones

Also add host-side listing assignment of service areas, not just one pickup spot.

### 7. `frontend/src/app/host/page.js`
Upgrade the host UX from simple pickup spots to real marketplace discovery setup.

Add:
- searchable toggle
- reveal mode
- pickup vs delivery eligibility
- service area management
- better preview of how the guest will see the place
- “public marketplace preview” card for each pickup spot

### 8. `frontend/src/app/become-a-host/page.js`
Use the same concept during onboarding.

Add:
- pickup spot visibility guidance
- “exact address stays hidden until booking” explanation
- optional service area capture
- searchable pickup label instead of forcing exact guest-facing address behavior

### 9. `frontend/src/app/book/page.js`
Replace branch-style search with marketplace-style place search.

Current issue:
- `Preferred Location` behaves like a branch selector

Change to:
- `Where do you want the car?`
- autocomplete or grouped options:
  - airports
  - neighborhoods
  - hotels
  - tenant branches
  - host pickup spots
- then show:
  - `Pick up here`
  - `Get it delivered`
  - `Closest options`

Need:
- new search place picker
- better car sharing result cards with `matchReason`
- fulfillment selector tied to the matched place

### 10. `frontend/src/app/car-sharing/page.js`
Internal admin console still assumes listing location is the trip pickup location.
Refactor trip create flow to use the same fulfillment plan concepts as public booking.

### 11. `backend/src/modules/issue-center/` and `planner/` later follow-up
Once `TripFulfillmentPlan` exists, later connect it to:
- issue handling for handoff disputes
- planner views for marketplace pickups and returns
- self-service handoff logic

## Competitive Edge Strategy

### Where Turo is strong
- location-first guest search
- pickup or delivery choice
- airport/hotel/neighborhood mental model
- handoff details revealed closer to booking/trip

### How We Beat Them
1. Stronger tenant ops controls
- airport presets
- allowed handoff modes
- after-hours rules
- branch anchoring

2. Better host privacy
- approximate public labels before booking
- exact address reveal rules

3. Better fulfillment modeling
- separate search place, service area, and exact handoff point

4. Better integration with our platform
- self-service pickup/drop-off
- key exchange readiness
- issue center handoff disputes
- planner/ops visibility

## Recommended Implementation Order
1. Prisma models and migration
2. backend `search place` resolution in booking engine
3. public booking payload changes
4. trip fulfillment plan persistence
5. host pickup spot + service area controls in host app
6. public booking search UI refactor
7. internal car-sharing trip flow update

## MVP Definition
The first real win is:
- guests can search by a public host pickup place, not only branch location
- listings can be matched by pickup spot and service area
- booking stores a fulfillment plan
- exact handoff details stay private until booking when configured

That alone would move us meaningfully closer to — and in some ways ahead of — Turo.
