-- =====================================================================
-- Rollback the 2026-05-27 silent overdue omit.
-- Flip every overdueIgnored=true row back to false. Code that filters
-- on `overdueIgnored: false` becomes a no-op (matches every row) so no
-- backend changes are needed. The column itself stays in the schema in
-- case we want to selectively hide rows in the future.
-- =====================================================================

-- 1) DRY RUN — confirm we're touching the rows we expect
SELECT COUNT(*) AS will_unignore
FROM   "Reservation"
WHERE  "overdueIgnored" = TRUE;


-- 2) APPLY
BEGIN;

UPDATE "Reservation"
SET    "overdueIgnored" = FALSE,
       "updatedAt"      = NOW()
WHERE  "overdueIgnored" = TRUE;

-- 3) Clean up the grandfather audit rows so the timeline isn't cluttered
--    with the now-undone bulk action.
DELETE FROM "AuditLog"
WHERE  reason = 'Grandfathered into overdueIgnored=true — pre-2026-05-27 stale data, won''t count toward overdue tracking';

-- 4) Verify — should be 0 left
SELECT
  COUNT(*) FILTER (WHERE "overdueIgnored" = TRUE)  AS still_ignored,
  COUNT(*) FILTER (WHERE "overdueIgnored" = FALSE) AS tracked,
  -- Sanity: how many overdue rows are visible again? Should match the
  -- pre-grandfather number (~441 minus the few that closed since then).
  COUNT(*) FILTER (
    WHERE "overdueIgnored" = FALSE
      AND (
        (status = 'CHECKED_OUT'        AND "returnAt" < NOW())
        OR (status IN ('NEW','CONFIRMED') AND "pickupAt" < NOW())
      )
  ) AS visible_overdue
FROM   "Reservation";

COMMIT;
-- ROLLBACK;
