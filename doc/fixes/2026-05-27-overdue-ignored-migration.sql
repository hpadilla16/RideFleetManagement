-- =====================================================================
-- Migration: add Reservation.overdueIgnored column + grandfather
-- pre-2026-05-27 overdue rows so they stop counting in the Overdue
-- Returns KPI, /reservations?filter=overdue list, and the OVERDUE
-- bucket of the Rental Status report.
--
-- Reservations created after this migration default to overdueIgnored
-- = false, so new overdues continue to be tracked normally.
--
-- Run order:
--   1) APPLY this script  (adds column, sets flag on existing overdues)
--   2) Deploy backend     (the three filter sites that read the column)
--
-- Order matters: deploying backend code that references a column that
-- doesn't exist throws Prisma validation errors. Running the DDL first
-- is safe — old code ignores the new column.
-- =====================================================================

BEGIN;

-- 1) Add the column with default false. Postgres handles this fast even
--    on big tables when the default is a constant.
ALTER TABLE "Reservation"
  ADD COLUMN IF NOT EXISTS "overdueIgnored" BOOLEAN NOT NULL DEFAULT FALSE;

-- 2) Flip the flag on every reservation that is currently overdue
--    (matches the dashboard KPI definition exactly).
--    Excludes RES-623949 (just reverted; should be tracked normally).
WITH targets AS (
  SELECT id
  FROM   "Reservation"
  WHERE  "reservationNumber" <> 'RES-623949'
    AND  (
      (status = 'CHECKED_OUT'        AND "returnAt" < NOW())
      OR (status IN ('NEW','CONFIRMED') AND "pickupAt" < NOW())
    )
)
UPDATE "Reservation" r
SET    "overdueIgnored" = TRUE,
       "updatedAt"      = NOW()
FROM   targets
WHERE  r.id = targets.id;

-- 3) Audit row per grandfathered reservation
INSERT INTO "AuditLog" (id, "reservationId", "actorUserId", action,
                        "fromStatus", "toStatus", reason, metadata, "createdAt")
SELECT
  'log_' || substr(md5(random()::text || r.id), 1, 24),
  r.id,
  NULL,
  'UPDATE',
  NULL,
  NULL,
  'Grandfathered into overdueIgnored=true — pre-2026-05-27 stale data, won''t count toward overdue tracking',
  json_build_object(
    'overdueIgnoredGrandfather', true,
    'status', r.status,
    'pickupAt', r."pickupAt",
    'returnAt', r."returnAt"
  )::text,
  NOW()
FROM   "Reservation" r
WHERE  r."overdueIgnored" = TRUE
  AND  r."updatedAt" >= NOW() - INTERVAL '1 minute';

-- 4) Verify — should report a count + the dashboard overdue count
--    after the deploy should be 0.
SELECT
  COUNT(*) FILTER (WHERE "overdueIgnored" = TRUE)  AS grandfathered_count,
  COUNT(*) FILTER (WHERE "overdueIgnored" = FALSE) AS still_tracked_count,
  -- Sanity: anything overdue AND still tracked is unexpected (new
  -- reservation that became overdue between row pull and now, or
  -- RES-623949 which is excluded by design).
  COUNT(*) FILTER (
    WHERE "overdueIgnored" = FALSE
      AND (
        (status = 'CHECKED_OUT'        AND "returnAt" < NOW())
        OR (status IN ('NEW','CONFIRMED') AND "pickupAt" < NOW())
      )
  )                                                  AS tracked_overdue_remaining
FROM   "Reservation";

COMMIT;
-- ROLLBACK;
