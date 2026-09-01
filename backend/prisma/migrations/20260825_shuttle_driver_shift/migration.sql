-- Shuttle v2 Phase 3 — DRIVER MODE substrate (2026-08-25, approved mockup
-- Screens 12–15 + 17a). Additive + idempotent per the migration rules
-- (startup-migrate applies this on boot; mirrors 20260824_shuttle_zones_alerts
-- / 20260825_shuttle_phase3_core). Inert on deploy: nothing changes for any
-- tenant until staff mints a driver-shift link from the monitor — the shift
-- rows are the feature flag.

-- One driver, one shuttle, one shift. Token auth only (192-bit random,
-- expiring, revocable) — drivers have no user account by approved decision.
-- vehicleId/locationId are plain refs, NO foreign keys — same style as
-- ShuttleAlert.vehicleId: vehicles are hard-deleted when sold and must never
-- cascade into or block on a shift row; ownership and shuttle-configured-ness
-- are re-verified on every token resolution.
CREATE TABLE IF NOT EXISTS "ShuttleDriverShift" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT NOT NULL,
  "locationId"      TEXT NOT NULL,
  "vehicleId"       TEXT NOT NULL,
  "driverName"      TEXT NOT NULL,
  "token"           TEXT NOT NULL,
  "expiresAt"       TIMESTAMPTZ NOT NULL,
  "revokedAt"       TIMESTAMPTZ,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The token alone resolves the driver page — unique, same as ShuttleTrackerLink.
CREATE UNIQUE INDEX IF NOT EXISTS "ShuttleDriverShift_token_key"
  ON "ShuttleDriverShift" ("token");
CREATE INDEX IF NOT EXISTS "ShuttleDriverShift_tenantId_locationId_expiresAt_idx"
  ON "ShuttleDriverShift" ("tenantId", "locationId", "expiresAt");
CREATE INDEX IF NOT EXISTS "ShuttleDriverShift_tenantId_vehicleId_idx"
  ON "ShuttleDriverShift" ("tenantId", "vehicleId");

-- Store→driver messages, keyed by shift, read on every driver poll (last ~20).
-- Deliberately NOT a ShuttleAlert reuse: the alert feed is the staff geofence
-- surface and rawJson has no keyed shiftId lookup.
CREATE TABLE IF NOT EXISTS "ShuttleDriverMessage" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT NOT NULL,
  "shiftId"         TEXT NOT NULL,
  "message"         TEXT NOT NULL,
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ShuttleDriverMessage_tenantId_shiftId_createdAt_idx"
  ON "ShuttleDriverMessage" ("tenantId", "shiftId", "createdAt");
