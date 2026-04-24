-- Website-only "Stop Sale" blocks: hide vehicles of a given class
-- from the public booking website for a date range without affecting
-- backoffice/manual reservations. See docs/operations/stop-sale-plan.md.

CREATE TABLE "VehicleClassStopSale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vehicleTypeId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleClassStopSale_pkey" PRIMARY KEY ("id")
);

-- Primary lookup path: public booking availability asks "for this tenant +
-- these vehicleTypeIds, is there any active stop-sale whose date range
-- overlaps [pickupAt, returnAt]?"
CREATE INDEX "VehicleClassStopSale_tenantId_vehicleTypeId_isActive_startDate_endDate_idx"
    ON "VehicleClassStopSale"("tenantId", "vehicleTypeId", "isActive", "startDate", "endDate");

-- Secondary: settings UI lists all active stop-sales for a tenant.
CREATE INDEX "VehicleClassStopSale_tenantId_isActive_idx"
    ON "VehicleClassStopSale"("tenantId", "isActive");

ALTER TABLE "VehicleClassStopSale" ADD CONSTRAINT "VehicleClassStopSale_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VehicleClassStopSale" ADD CONSTRAINT "VehicleClassStopSale_vehicleTypeId_fkey"
    FOREIGN KEY ("vehicleTypeId") REFERENCES "VehicleType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
