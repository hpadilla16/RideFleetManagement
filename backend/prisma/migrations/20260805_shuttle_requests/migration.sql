-- 2026-08-05 — Shuttle Requests (Valet arc). Chloe creates them after
-- validating the reservation; RFM floor agents dispatch and close.
-- Additive + idempotent: safe under AUTO_MIGRATE_ON_BOOT re-runs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShuttleRequestStatus') THEN
    CREATE TYPE "ShuttleRequestStatus" AS ENUM ('READY', 'VIEWED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ShuttleRequest" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "locationId"     TEXT NOT NULL,
  "reservationId"  TEXT NOT NULL,
  "customerName"   TEXT NOT NULL,
  "customerPhone"  TEXT,
  "partySize"      INTEGER NOT NULL DEFAULT 1,
  "pickupNote"     TEXT,
  "status"         "ShuttleRequestStatus" NOT NULL DEFAULT 'READY',
  "callCount"      INTEGER NOT NULL DEFAULT 1,
  "viewedAt"       TIMESTAMP(3),
  "viewedByUserId" TEXT,
  "closedAt"       TIMESTAMP(3),
  "closedByUserId" TEXT,
  "closeReason"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShuttleRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ShuttleRequest_tenantId_locationId_status_idx" ON "ShuttleRequest"("tenantId", "locationId", "status");
CREATE INDEX IF NOT EXISTS "ShuttleRequest_reservationId_status_idx" ON "ShuttleRequest"("reservationId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShuttleRequest_tenantId_fkey') THEN
    ALTER TABLE "ShuttleRequest" ADD CONSTRAINT "ShuttleRequest_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShuttleRequest_locationId_fkey') THEN
    ALTER TABLE "ShuttleRequest" ADD CONSTRAINT "ShuttleRequest_locationId_fkey"
      FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ShuttleRequest_reservationId_fkey') THEN
    ALTER TABLE "ShuttleRequest" ADD CONSTRAINT "ShuttleRequest_reservationId_fkey"
      FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON UPDATE CASCADE;
  END IF;
END $$;
