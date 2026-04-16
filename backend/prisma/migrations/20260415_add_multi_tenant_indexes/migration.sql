-- Location: tenant-scoped list queries
CREATE INDEX IF NOT EXISTS "Location_tenantId_idx" ON "Location"("tenantId");

-- VehicleType: tenant-scoped lookups
CREATE INDEX IF NOT EXISTS "VehicleType_tenantId_idx" ON "VehicleType"("tenantId");

-- Vehicle: tenant + status for availability/list queries
CREATE INDEX IF NOT EXISTS "Vehicle_tenantId_status_idx" ON "Vehicle"("tenantId", "status");

-- RentalAgreement: tenant + status for filtered agreement queries
CREATE INDEX IF NOT EXISTS "RentalAgreement_tenantId_status_idx" ON "RentalAgreement"("tenantId", "status");

-- Fee: tenant + active status lookups
CREATE INDEX IF NOT EXISTS "Fee_tenantId_isActive_idx" ON "Fee"("tenantId", "isActive");

-- AdditionalService: tenant + active status lookups
CREATE INDEX IF NOT EXISTS "AdditionalService_tenantId_isActive_idx" ON "AdditionalService"("tenantId", "isActive");

-- Rate: tenant + active status lookups
CREATE INDEX IF NOT EXISTS "Rate_tenantId_isActive_idx" ON "Rate"("tenantId", "isActive");
