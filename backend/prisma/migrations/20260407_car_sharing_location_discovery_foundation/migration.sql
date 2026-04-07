-- Create enums for marketplace location discovery.
CREATE TYPE "CarSharingSearchPlaceType" AS ENUM (
  'AIRPORT',
  'HOTEL',
  'NEIGHBORHOOD',
  'STATION',
  'TENANT_BRANCH',
  'HOST_PICKUP_SPOT',
  'DELIVERY_ZONE'
);

CREATE TYPE "CarSharingPlaceVisibilityMode" AS ENUM (
  'APPROXIMATE_ONLY',
  'REVEAL_AFTER_BOOKING',
  'PUBLIC_EXACT'
);

CREATE TYPE "HostServiceAreaType" AS ENUM (
  'PICKUP',
  'DELIVERY',
  'BOTH'
);

CREATE TYPE "TripFulfillmentChoice" AS ENUM (
  'PICKUP',
  'DELIVERY'
);

CREATE TYPE "TripHandoffMode" AS ENUM (
  'IN_PERSON',
  'LOCKBOX',
  'REMOTE_UNLOCK',
  'SELF_SERVICE'
);

-- Searchable public places for car sharing discovery.
CREATE TABLE "CarSharingSearchPlace" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "hostProfileId" TEXT,
  "hostPickupSpotId" TEXT,
  "anchorLocationId" TEXT,
  "placeType" "CarSharingSearchPlaceType" NOT NULL,
  "label" TEXT NOT NULL,
  "publicLabel" TEXT,
  "city" TEXT,
  "state" TEXT,
  "postalCode" TEXT,
  "country" TEXT,
  "latitude" DECIMAL(10,7),
  "longitude" DECIMAL(10,7),
  "radiusMiles" INTEGER,
  "searchable" BOOLEAN NOT NULL DEFAULT true,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "visibilityMode" "CarSharingPlaceVisibilityMode" NOT NULL DEFAULT 'REVEAL_AFTER_BOOKING',
  "deliveryEligible" BOOLEAN NOT NULL DEFAULT false,
  "pickupEligible" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CarSharingSearchPlace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CarSharingSearchPlace_hostPickupSpotId_key" ON "CarSharingSearchPlace"("hostPickupSpotId");
CREATE INDEX "CarSharingSearchPlace_tenantId_placeType_searchable_isActive_idx" ON "CarSharingSearchPlace"("tenantId", "placeType", "searchable", "isActive");
CREATE INDEX "CarSharingSearchPlace_hostProfileId_searchable_isActive_idx" ON "CarSharingSearchPlace"("hostProfileId", "searchable", "isActive");
CREATE INDEX "CarSharingSearchPlace_anchorLocationId_placeType_idx" ON "CarSharingSearchPlace"("anchorLocationId", "placeType");
CREATE INDEX "CarSharingSearchPlace_approvalStatus_isActive_idx" ON "CarSharingSearchPlace"("approvalStatus", "isActive");

ALTER TABLE "CarSharingSearchPlace"
  ADD CONSTRAINT "CarSharingSearchPlace_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CarSharingSearchPlace"
  ADD CONSTRAINT "CarSharingSearchPlace_hostProfileId_fkey"
  FOREIGN KEY ("hostProfileId") REFERENCES "HostProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CarSharingSearchPlace"
  ADD CONSTRAINT "CarSharingSearchPlace_hostPickupSpotId_fkey"
  FOREIGN KEY ("hostPickupSpotId") REFERENCES "HostPickupSpot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CarSharingSearchPlace"
  ADD CONSTRAINT "CarSharingSearchPlace_anchorLocationId_fkey"
  FOREIGN KEY ("anchorLocationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Host pickup/delivery service coverage.
CREATE TABLE "HostServiceArea" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "hostProfileId" TEXT NOT NULL,
  "listingId" TEXT,
  "searchPlaceId" TEXT,
  "serviceType" "HostServiceAreaType" NOT NULL DEFAULT 'PICKUP',
  "radiusMiles" INTEGER,
  "feeOverride" DECIMAL(10,2),
  "leadTimeMinutes" INTEGER,
  "afterHoursAllowed" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HostServiceArea_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HostServiceArea_tenantId_hostProfileId_isActive_idx" ON "HostServiceArea"("tenantId", "hostProfileId", "isActive");
CREATE INDEX "HostServiceArea_listingId_serviceType_isActive_idx" ON "HostServiceArea"("listingId", "serviceType", "isActive");
CREATE INDEX "HostServiceArea_searchPlaceId_serviceType_isActive_idx" ON "HostServiceArea"("searchPlaceId", "serviceType", "isActive");

ALTER TABLE "HostServiceArea"
  ADD CONSTRAINT "HostServiceArea_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HostServiceArea"
  ADD CONSTRAINT "HostServiceArea_hostProfileId_fkey"
  FOREIGN KEY ("hostProfileId") REFERENCES "HostProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HostServiceArea"
  ADD CONSTRAINT "HostServiceArea_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "HostVehicleListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HostServiceArea"
  ADD CONSTRAINT "HostServiceArea_searchPlaceId_fkey"
  FOREIGN KEY ("searchPlaceId") REFERENCES "CarSharingSearchPlace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Trip-level fulfillment plan chosen during booking.
CREATE TABLE "TripFulfillmentPlan" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "tripId" TEXT NOT NULL,
  "searchPlaceId" TEXT,
  "pickupSpotId" TEXT,
  "serviceAreaId" TEXT,
  "fulfillmentChoice" "TripFulfillmentChoice" NOT NULL DEFAULT 'PICKUP',
  "deliveryAreaChoiceLabel" TEXT,
  "pickupRevealMode" "CarSharingPlaceVisibilityMode" NOT NULL DEFAULT 'REVEAL_AFTER_BOOKING',
  "handoffMode" "TripHandoffMode" NOT NULL DEFAULT 'IN_PERSON',
  "exactAddress1" TEXT,
  "exactAddress2" TEXT,
  "city" TEXT,
  "state" TEXT,
  "postalCode" TEXT,
  "country" TEXT,
  "latitude" DECIMAL(10,7),
  "longitude" DECIMAL(10,7),
  "instructions" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TripFulfillmentPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TripFulfillmentPlan_tripId_key" ON "TripFulfillmentPlan"("tripId");
CREATE INDEX "TripFulfillmentPlan_tenantId_fulfillmentChoice_confirmedAt_idx" ON "TripFulfillmentPlan"("tenantId", "fulfillmentChoice", "confirmedAt");
CREATE INDEX "TripFulfillmentPlan_searchPlaceId_idx" ON "TripFulfillmentPlan"("searchPlaceId");
CREATE INDEX "TripFulfillmentPlan_pickupSpotId_idx" ON "TripFulfillmentPlan"("pickupSpotId");
CREATE INDEX "TripFulfillmentPlan_serviceAreaId_idx" ON "TripFulfillmentPlan"("serviceAreaId");

ALTER TABLE "TripFulfillmentPlan"
  ADD CONSTRAINT "TripFulfillmentPlan_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TripFulfillmentPlan"
  ADD CONSTRAINT "TripFulfillmentPlan_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TripFulfillmentPlan"
  ADD CONSTRAINT "TripFulfillmentPlan_searchPlaceId_fkey"
  FOREIGN KEY ("searchPlaceId") REFERENCES "CarSharingSearchPlace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TripFulfillmentPlan"
  ADD CONSTRAINT "TripFulfillmentPlan_pickupSpotId_fkey"
  FOREIGN KEY ("pickupSpotId") REFERENCES "HostPickupSpot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TripFulfillmentPlan"
  ADD CONSTRAINT "TripFulfillmentPlan_serviceAreaId_fkey"
  FOREIGN KEY ("serviceAreaId") REFERENCES "HostServiceArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;
