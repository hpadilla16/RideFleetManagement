-- Customer: tenant-scoped queries
CREATE INDEX IF NOT EXISTS "Customer_tenantId_idx" ON "Customer"("tenantId");
CREATE INDEX IF NOT EXISTS "Customer_tenantId_lastName_idx" ON "Customer"("tenantId", "lastName");

-- Reservation: tenant + status + pickupAt for filtered list queries
CREATE INDEX IF NOT EXISTS "Reservation_tenantId_status_pickupAt_idx" ON "Reservation"("tenantId", "status", "pickupAt");
