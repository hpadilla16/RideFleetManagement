-- Performance indexes for Reservation queries
CREATE INDEX IF NOT EXISTS "Reservation_customerId_idx" ON "Reservation"("customerId");
CREATE INDEX IF NOT EXISTS "Reservation_returnAt_idx" ON "Reservation"("returnAt");
CREATE INDEX IF NOT EXISTS "Reservation_tenantId_status_returnAt_idx" ON "Reservation"("tenantId", "status", "returnAt");
CREATE INDEX IF NOT EXISTS "Reservation_vehicleId_idx" ON "Reservation"("vehicleId");
