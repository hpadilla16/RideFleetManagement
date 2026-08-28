-- Shuttle v2 Phase 3 CORE — intake fields, manual assignment, pickup-spot ref
-- (2026-08-25, approved mockup Screens 6/7/8/9/10/17). Additive + idempotent
-- per the migration rules (startup-migrate applies this on boot; mirrors
-- 20260824_shuttle_zones_alerts). Inert on deploy: nothing changes for any
-- tenant until staff turns the new intake flag ON in the tracker config
-- (intakeJson.enabled) or assigns a shuttle by hand — every column is
-- nullable, no backfill, no defaults that alter existing rows.

-- Intake Step 2 (Screen 7): "how many bags?" NULL = asked before this column
-- existed, or intake disabled at the sede.
ALTER TABLE "ShuttleRequest"
  ADD COLUMN IF NOT EXISTS "bags" INTEGER;

-- Manual staff assignment (Screen 8a "Van 2 · assigned to you"). Plain String
-- ref, NO foreign key — same style as ShuttleAlert.vehicleId: vehicles are
-- hard-deleted when sold, and a cascade from Vehicle must never delete or
-- block on a customer's request row. Ownership + shuttle-configured-ness are
-- re-verified at assign time and again on every public read.
ALTER TABLE "ShuttleRequest"
  ADD COLUMN IF NOT EXISTS "assignedVehicleId" TEXT;

-- Which pickup spot (ShuttleZone with isPickupSpot) the customer was directed
-- to in intake Step 3. Plain ref for the same no-cascade reason.
ALTER TABLE "ShuttleRequest"
  ADD COLUMN IF NOT EXISTS "pickupSpotZoneId" TEXT;

-- The tracker's mode-aware read resolves "the viewer's assigned vehicle";
-- driver surfaces will ask "which requests are mine" by vehicle.
CREATE INDEX IF NOT EXISTS "ShuttleRequest_assignedVehicleId_idx"
  ON "ShuttleRequest" ("assignedVehicleId");

-- Per-location intake knobs (Screen 7), JSON like the other tracker knobs:
-- { enabled: bool, partySizeCap: int, bagsCap: int }. NULL = intake OFF and
-- the server defaults (50 / 20) apply — zero behavior change for every
-- existing tenant until a sede flips enabled on in Settings.
ALTER TABLE "ShuttleTrackerConfig"
  ADD COLUMN IF NOT EXISTS "intakeJson" JSONB;
