-- =====================================================================
-- Diagnostic: list every vehicle the system thinks is AVAILABLE so we
-- can find the ~23 that are physically gone/in-shop but never got an
-- OUT_OF_SERVICE flip, MaintenanceJob, or VehicleAvailabilityBlock.
--
-- One row per vehicle. The bucket column tells you why the system
-- considers it available, the activity columns help you spot whether
-- it might actually be elsewhere.
--
-- TENANT id is inlined below as 'cmn98hc1u0085ke0i4vefujt3' (International
-- Rental Corp). To run against a different tenant, find-and-replace it.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Bucket summary — sanity check that this matches the dashboard
-- ---------------------------------------------------------------------
WITH fleet AS (
  SELECT v.id, v.plate, v.make, v.model, v.year, v.status, v."tenantId"
  FROM   "Vehicle" v
  WHERE  v."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  v.status <> 'OUT_OF_SERVICE'
),
rented AS (
  SELECT DISTINCT r."vehicleId"
  FROM   "Reservation" r
  WHERE  r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  r.status = 'CHECKED_OUT'
    AND  r."pickupAt" <= NOW()
    AND  r."returnAt" > NOW() - INTERVAL '14 days'
    AND  r."vehicleId" IS NOT NULL
),
blocked AS (
  SELECT DISTINCT b."vehicleId"
  FROM   "VehicleAvailabilityBlock" b
  WHERE  b."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  b."releasedAt" IS NULL
    AND  b."blockedFrom" <= NOW()
    AND  b."availableFrom" > NOW()
    AND  b."blockType" IN ('MAINTENANCE_HOLD', 'OUT_OF_SERVICE_HOLD', 'WASH_HOLD')
  UNION
  SELECT DISTINCT j."vehicleId"
  FROM   "MaintenanceJob" j
  JOIN   "Vehicle" v ON v.id = j."vehicleId"
  WHERE  v."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  j.status IN ('OPEN', 'IN_PROGRESS')
)
SELECT
  COUNT(*)                                                              AS total_fleet,
  COUNT(*) FILTER (WHERE id IN (SELECT "vehicleId" FROM rented))        AS rented,
  COUNT(*) FILTER (WHERE id IN (SELECT "vehicleId" FROM blocked))       AS blocked,
  COUNT(*) FILTER (WHERE id NOT IN (SELECT "vehicleId" FROM rented)
                     AND id NOT IN (SELECT "vehicleId" FROM blocked))   AS available
FROM   fleet;

-- ---------------------------------------------------------------------
-- 2) The list — every vehicle the system thinks is AVAILABLE,
--    annotated with its last reservation activity so you can spot the
--    ones that don't belong.
-- ---------------------------------------------------------------------
WITH fleet AS (
  SELECT v.id, v.plate, v.make, v.model, v.year, v.status, v."tenantId",
         v.mileage, v."updatedAt"
  FROM   "Vehicle" v
  WHERE  v."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  v.status <> 'OUT_OF_SERVICE'
),
rented AS (
  SELECT DISTINCT r."vehicleId"
  FROM   "Reservation" r
  WHERE  r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  r.status = 'CHECKED_OUT'
    AND  r."pickupAt" <= NOW()
    AND  r."returnAt" > NOW() - INTERVAL '14 days'
    AND  r."vehicleId" IS NOT NULL
),
blocked AS (
  SELECT DISTINCT b."vehicleId"
  FROM   "VehicleAvailabilityBlock" b
  WHERE  b."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  b."releasedAt" IS NULL
    AND  b."blockedFrom" <= NOW()
    AND  b."availableFrom" > NOW()
    AND  b."blockType" IN ('MAINTENANCE_HOLD', 'OUT_OF_SERVICE_HOLD', 'WASH_HOLD')
  UNION
  SELECT DISTINCT j."vehicleId"
  FROM   "MaintenanceJob" j
  JOIN   "Vehicle" v ON v.id = j."vehicleId"
  WHERE  v."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  j.status IN ('OPEN', 'IN_PROGRESS')
),
last_res AS (
  SELECT DISTINCT ON (r."vehicleId")
         r."vehicleId",
         r."reservationNumber" AS last_res_number,
         r.status              AS last_res_status,
         r."pickupAt"          AS last_pickup,
         r."returnAt"          AS last_return
  FROM   "Reservation" r
  WHERE  r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  r."vehicleId" IS NOT NULL
  ORDER BY r."vehicleId", r."pickupAt" DESC
),
assigned_pending AS (
  -- NEW/CONFIRMED reservations that already have a vehicle assigned and
  -- have a pickupAt within the next 24h. These technically aren't "out
  -- on rent" but they're also not really free to give to a walk-in.
  SELECT DISTINCT r."vehicleId"
  FROM   "Reservation" r
  WHERE  r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  r.status IN ('NEW', 'CONFIRMED')
    AND  r."vehicleId" IS NOT NULL
    AND  r."pickupAt" BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
)
SELECT
  f.plate,
  f.year || ' ' || f.make || ' ' || f.model                AS vehicle,
  f.status                                                  AS vehicle_status,
  f.mileage,
  CASE
    WHEN f.id IN (SELECT "vehicleId" FROM rented)            THEN 'RENTED'
    WHEN f.id IN (SELECT "vehicleId" FROM blocked)           THEN 'BLOCKED'
    WHEN f.id IN (SELECT "vehicleId" FROM assigned_pending)  THEN 'AVAILABLE (assigned-to-pending)'
    ELSE                                                          'AVAILABLE'
  END                                                       AS bucket,
  lr.last_res_number,
  lr.last_res_status,
  lr.last_pickup,
  lr.last_return,
  -- How many days since the vehicle's row was touched. Stale rows
  -- (>30 days) are good candidates for "physically gone, never marked".
  EXTRACT(DAY FROM (NOW() - f."updatedAt"))::int            AS days_since_vehicle_update
FROM   fleet f
LEFT JOIN last_res lr ON lr."vehicleId" = f.id
WHERE  f.id NOT IN (SELECT "vehicleId" FROM rented)
  AND  f.id NOT IN (SELECT "vehicleId" FROM blocked)
ORDER BY
  CASE
    WHEN f.id IN (SELECT "vehicleId" FROM assigned_pending) THEN 1
    ELSE 2
  END,
  lr.last_return DESC NULLS LAST;

-- ---------------------------------------------------------------------
-- 3) Once you've identified the missing 23, here are the three fixes
--    you can run individually (one per plate or in bulk). Pick whichever
--    matches reality for each vehicle.
-- ---------------------------------------------------------------------

-- 3a) Vehicle sold / totaled / transferred — mark OUT_OF_SERVICE
--     (removes it from totalFleet entirely).
-- UPDATE "Vehicle"
-- SET    status = 'OUT_OF_SERVICE', "updatedAt" = NOW()
-- WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
--   AND  plate IN ('XXX-001', 'XXX-002', ...);

-- 3b) Vehicle in shop with no MaintenanceJob — open a quick block.
--     Released later via the UI or by setting releasedAt manually.
-- INSERT INTO "VehicleAvailabilityBlock"
--   (id, "tenantId", "vehicleId", "blockType", "blockedFrom",
--    "availableFrom", "releasedAt", reason, "createdAt", "updatedAt")
-- SELECT
--   'blk_' || substr(md5(random()::text || v.id), 1, 24),
--   v."tenantId",
--   v.id,
--   'MAINTENANCE_HOLD',
--   NOW(),
--   NOW() + INTERVAL '30 days',
--   NULL,
--   '2026-05-27 reconciliation — physically in shop, no MJ on file',
--   NOW(),
--   NOW()
-- FROM   "Vehicle" v
-- WHERE  v."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
--   AND  v.plate IN ('XXX-003', 'XXX-004', ...);

-- 3c) Vehicle still out on rent but reservation lost (data corruption /
--     never properly checked out). Best fix: find the reservation and
--     correct its status; failing that, mark the vehicle as ON_RENT and
--     create a placeholder block until you can reconstruct the rental.
-- UPDATE "Vehicle"
-- SET    status = 'ON_RENT', "updatedAt" = NOW()
-- WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
--   AND  plate IN ('XXX-005', ...);
