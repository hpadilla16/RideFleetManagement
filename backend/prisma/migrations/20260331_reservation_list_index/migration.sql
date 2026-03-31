CREATE INDEX IF NOT EXISTS "Reservation_tenantId_createdAt_idx"
ON "Reservation"("tenantId", "createdAt");
