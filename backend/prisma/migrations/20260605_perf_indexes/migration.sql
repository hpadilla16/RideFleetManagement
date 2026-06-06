-- 2026-06-05 — performance indexes for the slow-request batch
-- (availability-forecast 9.5–10.1s, planner/snapshot 8.9s — droplet logs).
-- Additive + idempotent. Plain CREATE INDEX (not CONCURRENTLY) on purpose:
-- prisma migrate runs migrations inside a transaction where CONCURRENTLY
-- is illegal, and at ~1k Reservation rows the lock window is milliseconds.

-- Serves the date-window overlap queries used by availability-forecast,
-- planner snapshot and booking-engine availability:
--   WHERE "tenantId" = $1 AND "pickupAt" < $end AND "returnAt" > $start
-- (forecast adds status IN (...) + "overdueIgnored" = false, planner has no
-- status predicate — so the status-leading indexes don't apply).
CREATE INDEX IF NOT EXISTS "Reservation_tenantId_returnAt_pickupAt_idx"
  ON "Reservation" ("tenantId", "returnAt", "pickupAt");

-- Serves vehicle-intelligence's latest-telematics-event lookup
-- (DISTINCT ON ("vehicleId") ... ORDER BY "vehicleId", "eventAt" DESC),
-- which runs without a tenant filter for super-admin scope and therefore
-- can't use ("tenantId", "vehicleId", "eventAt").
CREATE INDEX IF NOT EXISTS "VehicleTelematicsEvent_vehicleId_eventAt_idx"
  ON "VehicleTelematicsEvent" ("vehicleId", "eventAt" DESC);
