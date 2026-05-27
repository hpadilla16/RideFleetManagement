-- =====================================================================
-- Bulk close-out for stale overdue CHECKED_OUT reservations.
-- Hector physically confirmed all of them have actually been returned;
-- this is purely an admin sync — no inspection, no fees, no autocharge.
--
-- Logic per reservation:
--   • If agreement.balance <= 0  → CHECKED_IN + agreement CLOSED (full)
--   • If agreement.balance >  0  → CHECKED_IN_UNPAID, agreement stays
--                                  FINALIZED (matches the per-row
--                                  "Mark returned" button)
--   • autochargeAt cleared either way
--   • RES-623949 explicitly excluded (just reverted; needs a real
--     re-checkin via the wizard)
--
-- Adjust the WHERE filter in the CTE if you want to scope by tenant.
-- Default scope: all tenants the user can see.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) DRY RUN — preview which reservations get touched and how
-- ---------------------------------------------------------------------
WITH overdue AS (
  SELECT
    r.id            AS reservation_id,
    r."reservationNumber",
    r.status        AS res_status,
    r."returnAt",
    ra.id           AS agreement_id,
    ra."agreementNumber",
    ra.status       AS ag_status,
    ra.balance      AS ag_balance,
    CASE
      WHEN COALESCE(ra.balance, 0) <= 0.01 THEN 'CHECKED_IN (full close)'
      ELSE                                       'CHECKED_IN_UNPAID (balance pending)'
    END             AS planned_action
  FROM   "Reservation" r
  LEFT JOIN "RentalAgreement" ra ON ra."reservationId" = r.id
  WHERE  r.status = 'CHECKED_OUT'
    AND  r."returnAt" < NOW()
    AND  r."reservationNumber" <> 'RES-623949'
)
SELECT
  COUNT(*)                                              AS total_overdue,
  COUNT(*) FILTER (WHERE planned_action LIKE 'CHECKED_IN %') AS will_full_close,
  COUNT(*) FILTER (WHERE planned_action LIKE 'CHECKED_IN_UNPAID%') AS will_mark_returned,
  COALESCE(SUM(ag_balance) FILTER (WHERE ag_balance > 0), 0)::numeric(10,2) AS total_pending_balance
FROM   overdue;

-- Optional: see the per-row list (uncomment to inspect a sample)
-- SELECT * FROM overdue ORDER BY "returnAt" LIMIT 50;


-- ---------------------------------------------------------------------
-- 2) APPLY — run inside a transaction. Verify counts before COMMIT.
-- ---------------------------------------------------------------------
BEGIN;

-- 2a) Full close: balance <= 0 → CHECKED_IN + agreement CLOSED + locked
WITH targets AS (
  SELECT r.id AS reservation_id, ra.id AS agreement_id
  FROM   "Reservation" r
  LEFT JOIN "RentalAgreement" ra ON ra."reservationId" = r.id
  WHERE  r.status = 'CHECKED_OUT'
    AND  r."returnAt" < NOW()
    AND  r."reservationNumber" <> 'RES-623949'
    AND  COALESCE(ra.balance, 0) <= 0.01
),
res_upd AS (
  UPDATE "Reservation" r
  SET    status         = 'CHECKED_IN',
         "autochargeAt" = NULL,
         "updatedAt"    = NOW()
  FROM   targets
  WHERE  r.id = targets.reservation_id
  RETURNING r.id
),
ag_upd AS (
  UPDATE "RentalAgreement" ra
  SET    status         = 'CLOSED',
         locked         = TRUE,
         "closedAt"     = NOW(),
         "updatedAt"    = NOW()
  FROM   targets
  WHERE  ra.id = targets.agreement_id
  RETURNING ra.id
)
SELECT 'full_close' AS bucket,
       (SELECT COUNT(*) FROM res_upd) AS reservations,
       (SELECT COUNT(*) FROM ag_upd)  AS agreements;

-- 2b) Mark returned: balance > 0 → CHECKED_IN_UNPAID, agreement untouched
WITH targets AS (
  SELECT r.id AS reservation_id
  FROM   "Reservation" r
  LEFT JOIN "RentalAgreement" ra ON ra."reservationId" = r.id
  WHERE  r.status = 'CHECKED_OUT'
    AND  r."returnAt" < NOW()
    AND  r."reservationNumber" <> 'RES-623949'
    AND  COALESCE(ra.balance, 0) > 0.01
),
res_upd AS (
  UPDATE "Reservation" r
  SET    status         = 'CHECKED_IN_UNPAID',
         "autochargeAt" = NULL,
         "updatedAt"    = NOW()
  FROM   targets
  WHERE  r.id = targets.reservation_id
  RETURNING r.id
)
SELECT 'mark_returned' AS bucket,
       (SELECT COUNT(*) FROM res_upd) AS reservations;

-- 2c) Audit log — one entry per touched reservation so we have a record
INSERT INTO "AuditLog" (id, "reservationId", "actorUserId", action,
                        "fromStatus", "toStatus", reason, metadata, "createdAt")
SELECT
  'log_' || substr(md5(random()::text || r.id), 1, 24),
  r.id,
  NULL,
  'STATUS_CHANGE',
  'CHECKED_OUT',
  r.status,
  'Bulk admin close-out — vehicles physically returned but never marked in system (2026-05-27 cleanup)',
  json_build_object(
    'bulkCleanup', true,
    'agreementBalance', COALESCE(ra.balance, 0),
    'reservationReturnAt', r."returnAt"
  )::text,
  NOW()
FROM   "Reservation" r
LEFT JOIN "RentalAgreement" ra ON ra."reservationId" = r.id
WHERE  r.status IN ('CHECKED_IN', 'CHECKED_IN_UNPAID')
  AND  r."updatedAt" >= NOW() - INTERVAL '1 minute'  -- only the rows we just touched
  AND  r."reservationNumber" <> 'RES-623949';

-- 2d) Sanity check — should now be 0 overdue CHECKED_OUT
SELECT COUNT(*) AS remaining_overdue_checked_out
FROM   "Reservation"
WHERE  status = 'CHECKED_OUT'
  AND  "returnAt" < NOW()
  AND  "reservationNumber" <> 'RES-623949';

-- If counts look right:
COMMIT;
-- otherwise:
-- ROLLBACK;
