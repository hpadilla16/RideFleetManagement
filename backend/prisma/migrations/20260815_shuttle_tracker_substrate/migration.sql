-- Shuttle tracker substrate (Hector, 2026-08-15). Inert on deploy: nothing
-- reads these until the engine phase ships. Additive + idempotent.
--
-- Security model (Hector's call): NO standing links. Every tracker link is
-- per-reservation, expiring, delivered by email + SMS. ShuttleRequest keeps
-- reservationId REQUIRED — with links always reservation-tied, the public
-- request path never needs an anonymous row, so the VozIA/valet write path
-- stays untouched.

ALTER TABLE "ShuttleRequest"
  ADD COLUMN IF NOT EXISTS "source" TEXT;

CREATE TABLE IF NOT EXISTS "ShuttleTrackerConfig" (
  "id"             TEXT PRIMARY KEY,
  "tenantId"       TEXT NOT NULL,
  "locationId"     TEXT NOT NULL,
  "mode"           TEXT NOT NULL DEFAULT 'OFF',
  "vehicleIdsJson" JSONB,
  "headwayMinutes" INTEGER NOT NULL DEFAULT 10,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShuttleTrackerConfig_locationId_key"
  ON "ShuttleTrackerConfig" ("locationId");
CREATE INDEX IF NOT EXISTS "ShuttleTrackerConfig_tenantId_idx"
  ON "ShuttleTrackerConfig" ("tenantId");

CREATE TABLE IF NOT EXISTS "ShuttleTrackerLink" (
  "id"            TEXT PRIMARY KEY,
  "tenantId"      TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "token"         TEXT NOT NULL,
  "expiresAt"     TIMESTAMPTZ NOT NULL,
  "revokedAt"     TIMESTAMPTZ,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShuttleTrackerLink_token_key"
  ON "ShuttleTrackerLink" ("token");
CREATE INDEX IF NOT EXISTS "ShuttleTrackerLink_reservationId_idx"
  ON "ShuttleTrackerLink" ("reservationId");
CREATE INDEX IF NOT EXISTS "ShuttleTrackerLink_tenantId_expiresAt_idx"
  ON "ShuttleTrackerLink" ("tenantId", "expiresAt");
