-- Shuttle v2 Phase 2 — geofence zones + provider alerts + arrival notification
-- (2026-08-24, approved mockup Screens 4/5/16). Additive + idempotent per the
-- migration rules (startup-migrate applies this on boot; mirrors
-- 20260815_shuttle_tracker_substrate / 20260823_retention_sweep). Inert on
-- deploy: nothing fires until a tenant defines a zone AND has an OneStepGPS
-- API key stored — the zone rows are the feature flag.

-- Customer said "text me when the shuttle arrives" (Screen 16 — strictly
-- opt-in). Default false: every existing row stays non-opted, zero backfill.
ALTER TABLE "ShuttleRequest"
  ADD COLUMN IF NOT EXISTS "smsOptIn" BOOLEAN NOT NULL DEFAULT false;

-- Per-location staff alert recipients (Screen 4 "Who gets alerted") — JSON
-- array of { name, email?, phone?, channels }. NULL = nobody subscribed.
ALTER TABLE "ShuttleTrackerConfig"
  ADD COLUMN IF NOT EXISTS "alertRecipientsJson" JSONB;

-- Staff-defined zones (pickup spots, base) and route corridors. Geometry is
-- synced to the GPS provider (detection is provider-side, approved decision
-- #9); providerZoneId is the provider's copy, providerSyncStatus tracks it.
CREATE TABLE IF NOT EXISTS "ShuttleZone" (
  "id"                 TEXT PRIMARY KEY,
  "tenantId"           TEXT NOT NULL,
  "locationId"         TEXT NOT NULL,
  "name"               TEXT NOT NULL,
  "kind"               TEXT NOT NULL DEFAULT 'ZONE',
  "isPickupSpot"       BOOLEAN NOT NULL DEFAULT false,
  "walkingDirections"  TEXT,
  "geometryJson"       JSONB NOT NULL,
  "toleranceM"         INTEGER,
  "providerZoneId"     TEXT,
  "providerSyncStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "providerSyncError"  TEXT,
  "notifyOnEnter"      BOOLEAN NOT NULL DEFAULT false,
  "notifyOnExit"       BOOLEAN NOT NULL DEFAULT false,
  "notifyOnOffRoute"   BOOLEAN NOT NULL DEFAULT false,
  "active"             BOOLEAN NOT NULL DEFAULT true,
  "createdAt"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ShuttleZone_tenantId_locationId_active_idx"
  ON "ShuttleZone" ("tenantId", "locationId", "active");
CREATE INDEX IF NOT EXISTS "ShuttleZone_tenantId_providerZoneId_idx"
  ON "ShuttleZone" ("tenantId", "providerZoneId");

-- Normalized provider alerts. The unique (tenantId, providerRef) is the
-- idempotency anchor: the poller re-reads a lookback window every tick and
-- re-seen alerts collapse into no-ops instead of duplicate rows (and
-- duplicate notifications — the arrival debounce hangs off this).
CREATE TABLE IF NOT EXISTS "ShuttleAlert" (
  "id"                TEXT PRIMARY KEY,
  "tenantId"          TEXT NOT NULL,
  "zoneId"            TEXT,
  "vehicleId"         TEXT,
  "type"              TEXT NOT NULL,
  "occurredAt"        TIMESTAMPTZ NOT NULL,
  "providerRef"       TEXT NOT NULL,
  "rawJson"           TEXT,
  "staffNotifiedAt"   TIMESTAMPTZ,
  "arrivalNotifiedAt" TIMESTAMPTZ,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShuttleAlert_tenantId_providerRef_key"
  ON "ShuttleAlert" ("tenantId", "providerRef");
CREATE INDEX IF NOT EXISTS "ShuttleAlert_tenantId_occurredAt_idx"
  ON "ShuttleAlert" ("tenantId", "occurredAt");
CREATE INDEX IF NOT EXISTS "ShuttleAlert_tenantId_zoneId_type_occurredAt_idx"
  ON "ShuttleAlert" ("tenantId", "zoneId", "type", "occurredAt");
