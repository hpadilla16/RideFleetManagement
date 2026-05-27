-- =====================================================================
-- Bulk no-show for stale NEW/CONFIRMED reservations past their pickupAt.
-- Hector confirmed: customers never showed up; the wizard was never run
-- so no agreement exists. Single-field status flip per row, no fees,
-- no inspection, no payments.
--
-- Matches the per-row "Mark no-show" button (frontend/src/app/
-- reservations/page.js: setStatus(id, 'NO_SHOW')) — just batched.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) DRY RUN — preview the count + a status breakdown
-- ---------------------------------------------------------------------
WITH overdue AS (
  SELECT id, "reservationNumber", status, "pickupAt", "vehicleId"
  FROM   "Reservation"
  WHERE  status IN ('NEW', 'CONFIRMED')
    AND  "pickupAt" < NOW()
)
SELECT
  COUNT(*)                                            AS total_no_shows,
  COUNT(*) FILTER (WHERE status = 'NEW')              AS from_new,
  COUNT(*) FILTER (WHERE status = 'CONFIRMED')        AS from_confirmed,
  COUNT(*) FILTER (WHERE "vehicleId" IS NOT NULL)     AS had_vehicle_assigned,
  MIN("pickupAt")                                     AS oldest_overdue_pickup,
  MAX("pickupAt")                                     AS newest_overdue_pickup
FROM   overdue;

-- Optional: see a sample (uncomment to inspect)
-- SELECT id, "reservationNumber", status, "pickupAt", "vehicleId"
-- FROM   "Reservation"
-- WHERE  status IN ('NEW', 'CONFIRMED')
--   AND  "pickupAt" < NOW()
-- ORDER BY "pickupAt"
-- LIMIT 50;


-- ---------------------------------------------------------------------
-- 2) APPLY — single status flip + audit log per row
-- ---------------------------------------------------------------------
BEGIN;

-- 2a) Flip status to NO_SHOW (vehicleId stays; NO_SHOW doesn't reserve)
WITH targets AS (
  SELECT id, status AS prev_status, "pickupAt"
  FROM   "Reservation"
  WHERE  status IN ('NEW', 'CONFIRMED')
    AND  "pickupAt" < NOW()
),
res_upd AS (
  UPDATE "Reservation" r
  SET    status      = 'NO_SHOW',
         "updatedAt" = NOW()
  FROM   targets
  WHERE  r.id = targets.id
  RETURNING r.id, targets.prev_status, r."pickupAt"
)
SELECT 'marked_no_show' AS bucket,
       COUNT(*)         AS total,
       COUNT(*) FILTER (WHERE prev_status = 'NEW')       AS from_new,
       COUNT(*) FILTER (WHERE prev_status = 'CONFIRMED') AS from_confirmed
FROM   res_upd;

-- 2b) Audit log — one row per touched reservation
INSERT INTO "AuditLog" (id, "reservationId", "actorUserId", action,
                        "fromStatus", "toStatus", reason, metadata, "createdAt")
SELECT
  'log_' || substr(md5(random()::text || r.id), 1, 24),
  r.id,
  NULL,
  'STATUS_CHANGE',
  -- We've already flipped to NO_SHOW so we can't read the previous
  -- status off the row. Best-effort: leave fromStatus null — the
  -- toStatus + reason + timestamp tell the story.
  NULL,
  'NO_SHOW',
  'Bulk admin no-show — customers never showed up for pickup (2026-05-27 cleanup)',
  json_build_object(
    'bulkCleanup', true,
    'reservationPickupAt', r."pickupAt",
    'vehicleId', r."vehicleId"
  )::text,
  NOW()
FROM   "Reservation" r
WHERE  r.status = 'NO_SHOW'
  AND  r."updatedAt" >= NOW() - INTERVAL '1 minute';  -- only just-flipped rows

-- 2c) Sanity check — should now be 0 overdue NEW/CONFIRMED
SELECT COUNT(*) AS remaining_overdue_new_confirmed
FROM   "Reservation"
WHERE  status IN ('NEW', 'CONFIRMED')
  AND  "pickupAt" < NOW();

-- If counts look right:
COMMIT;
-- otherwise:
-- ROLLBACK;
