-- Overdue-vehicle geofence check (Hector, 2026-08-13).
--
-- Location gains optional coordinates + radius: an overdue rental whose GPS
-- position is inside ANY geofenced location of the tenant is "returned but
-- not checked in" (no alert); outside all of them raises an
-- OverdueVehicleAlert shown on the dashboard. NULL coords = no geofence,
-- location skipped. Additive + idempotent per the migration rules.

ALTER TABLE "Location"
  ADD COLUMN IF NOT EXISTS "latitude" DECIMAL(9,6);
ALTER TABLE "Location"
  ADD COLUMN IF NOT EXISTS "longitude" DECIMAL(9,6);
ALTER TABLE "Location"
  ADD COLUMN IF NOT EXISTS "geofenceRadiusKm" DECIMAL(6,2);

CREATE TABLE IF NOT EXISTS "OverdueVehicleAlert" (
  "id"                TEXT PRIMARY KEY,
  "tenantId"          TEXT NOT NULL,
  "reservationId"     TEXT NOT NULL,
  "vehicleId"         TEXT,
  "status"            TEXT NOT NULL DEFAULT 'OPEN',
  "latitude"          DECIMAL(9,6),
  "longitude"         DECIMAL(9,6),
  "address"           TEXT,
  "distanceKm"        DECIMAL(8,2),
  "nearestLocationId" TEXT,
  "positionAt"        TIMESTAMPTZ,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "resolvedAt"        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "OverdueVehicleAlert_tenantId_status_idx"
  ON "OverdueVehicleAlert" ("tenantId", "status");
CREATE INDEX IF NOT EXISTS "OverdueVehicleAlert_reservationId_status_idx"
  ON "OverdueVehicleAlert" ("reservationId", "status");
