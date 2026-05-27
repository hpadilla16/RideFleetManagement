-- =====================================================================
-- Rollback for the two bulk operations run earlier today:
--   • 2026-05-27-bulk-close-overdue.sql    (CHECKED_OUT → CHECKED_IN / CHECKED_IN_UNPAID)
--   • 2026-05-27-bulk-mark-no-show.sql     (NEW/CONFIRMED → NO_SHOW)
--
-- Identification: both bulk scripts inserted distinct reason strings
-- into AuditLog. We find those rows, revert the reservation (and
-- agreement, when applicable), then delete the bulk-cleanup audit rows
-- so the rollback itself doesn't get rolled back next time.
--
-- For the close-out rollback we know the prior reservation status was
-- CHECKED_OUT (it's in fromStatus). For the no-show rollback the prior
-- status was NEW or CONFIRMED — we default to CONFIRMED. Either way
-- both will show in the overdue list so you can triage per-row.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) DRY RUN — confirm the counts we're about to revert
-- ---------------------------------------------------------------------
SELECT
  reason,
  COUNT(*) AS rows
FROM   "AuditLog"
WHERE  reason IN (
  'Bulk admin close-out — vehicles physically returned but never marked in system (2026-05-27 cleanup)',
  'Bulk admin no-show — customers never showed up for pickup (2026-05-27 cleanup)'
)
GROUP BY reason;


-- ---------------------------------------------------------------------
-- 2) APPLY — wrapped in one transaction
-- ---------------------------------------------------------------------
BEGIN;

-- 2a) Revert CHECKED_IN bulk rollbacks → CHECKED_OUT + agreement back
--     to FINALIZED (because balance <= 0 bucket flipped agreement to
--     CLOSED + locked + closedAt). Identified by the close-out reason
--     string + current reservation status of CHECKED_IN.
WITH targets AS (
  SELECT DISTINCT a."reservationId"
  FROM   "AuditLog" a
  JOIN   "Reservation" r ON r.id = a."reservationId"
  WHERE  a.reason = 'Bulk admin close-out — vehicles physically returned but never marked in system (2026-05-27 cleanup)'
    AND  r.status = 'CHECKED_IN'
),
res_upd AS (
  UPDATE "Reservation" r
  SET    status      = 'CHECKED_OUT',
         "updatedAt" = NOW()
  FROM   targets
  WHERE  r.id = targets."reservationId"
  RETURNING r.id
),
ag_upd AS (
  UPDATE "RentalAgreement" ra
  SET    status         = 'FINALIZED',
         locked         = FALSE,
         "closedAt"     = NULL,
         "closedByUserId" = NULL,
         "updatedAt"    = NOW()
  FROM   targets, "Reservation" r
  WHERE  r.id = targets."reservationId"
    AND  ra."reservationId" = r.id
  RETURNING ra.id
)
SELECT 'reverted_full_close' AS bucket,
       (SELECT COUNT(*) FROM res_upd) AS reservations,
       (SELECT COUNT(*) FROM ag_upd)  AS agreements;

-- 2b) Revert CHECKED_IN_UNPAID bulk rollbacks → CHECKED_OUT.
--     Agreement wasn't touched in the bulk close-out for this bucket,
--     so we only revert the reservation.
WITH targets AS (
  SELECT DISTINCT a."reservationId"
  FROM   "AuditLog" a
  JOIN   "Reservation" r ON r.id = a."reservationId"
  WHERE  a.reason = 'Bulk admin close-out — vehicles physically returned but never marked in system (2026-05-27 cleanup)'
    AND  r.status = 'CHECKED_IN_UNPAID'
),
res_upd AS (
  UPDATE "Reservation" r
  SET    status      = 'CHECKED_OUT',
         "updatedAt" = NOW()
  FROM   targets
  WHERE  r.id = targets."reservationId"
  RETURNING r.id
)
SELECT 'reverted_mark_returned' AS bucket,
       (SELECT COUNT(*) FROM res_upd) AS reservations;

-- 2c) Revert NO_SHOW bulk rollbacks → CONFIRMED.
--     Default to CONFIRMED (more common pre-NO_SHOW state for overdue
--     reservations). NEW vs CONFIRMED doesn't matter for visibility —
--     the overdue filter catches both.
WITH targets AS (
  SELECT DISTINCT a."reservationId"
  FROM   "AuditLog" a
  JOIN   "Reservation" r ON r.id = a."reservationId"
  WHERE  a.reason = 'Bulk admin no-show — customers never showed up for pickup (2026-05-27 cleanup)'
    AND  r.status = 'NO_SHOW'
),
res_upd AS (
  UPDATE "Reservation" r
  SET    status      = 'CONFIRMED',
         "updatedAt" = NOW()
  FROM   targets
  WHERE  r.id = targets."reservationId"
  RETURNING r.id
)
SELECT 'reverted_no_show' AS bucket,
       (SELECT COUNT(*) FROM res_upd) AS reservations;

-- 2d) Clean up the bulk-cleanup audit rows so the rollback itself can
--     be re-run cleanly if needed (and so they don't clutter the audit
--     view for these reservations).
DELETE FROM "AuditLog"
WHERE  reason IN (
  'Bulk admin close-out — vehicles physically returned but never marked in system (2026-05-27 cleanup)',
  'Bulk admin no-show — customers never showed up for pickup (2026-05-27 cleanup)'
);

-- 2e) Write a rollback audit entry per reverted reservation so we have
--     a record of the rollback itself.
INSERT INTO "AuditLog" (id, "reservationId", "actorUserId", action,
                        "fromStatus", "toStatus", reason, metadata, "createdAt")
SELECT
  'log_' || substr(md5(random()::text || r.id), 1, 24),
  r.id,
  NULL,
  'STATUS_CHANGE',
  NULL,
  r.status,
  'Rolled back from bulk 2026-05-27 cleanup — needs per-row triage',
  json_build_object('rollback', true, 'rolledBackAt', NOW())::text,
  NOW()
FROM   "Reservation" r
WHERE  r."updatedAt" >= NOW() - INTERVAL '1 minute'
  AND  r.status IN ('CHECKED_OUT', 'CONFIRMED');

-- 2f) Sanity check — should now see the overdue counts back up
SELECT
  COUNT(*) FILTER (WHERE status = 'CHECKED_OUT' AND "returnAt" < NOW()) AS overdue_checked_out,
  COUNT(*) FILTER (WHERE status IN ('NEW','CONFIRMED') AND "pickupAt" < NOW()) AS overdue_new_confirmed
FROM   "Reservation";

COMMIT;
-- ROLLBACK;
