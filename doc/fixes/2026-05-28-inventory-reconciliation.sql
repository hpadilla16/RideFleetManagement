-- =====================================================================
-- Inventory reconciliation for International Rental Corp
-- Based on the lot walk-through CSV (2026-05-28).
--
-- Three passes:
--   PASS 1 — ALTER TYPE to add 'SOLD' enum value. Must commit before
--            we can use it as a value in PASS 2.
--   PASS 2 — Update vehicle statuses per the CSV: 5 → SOLD, 3 → OOS.
--            Force-checkin all overdue CHECKED_OUT reservations.
--            Mark NO_SHOW on all overdue NEW/CONFIRMED.
--   PASS 3 — Verify the final state matches the CSV.
--
-- Tenant: International Rental Corp (cmn98hc1u0085ke0i4vefujt3)
-- =====================================================================


-- ---------------------------------------------------------------------
-- PASS 1 — Add SOLD to the VehicleStatus enum
-- Run this on its own, COMMIT, then run PASS 2.
-- ---------------------------------------------------------------------
ALTER TYPE "VehicleStatus" ADD VALUE IF NOT EXISTS 'SOLD';


-- ---------------------------------------------------------------------
-- PASS 2 — Data reconciliation (run as a single transaction)
-- ---------------------------------------------------------------------
BEGIN;

-- 2a) Vehicle status flips per the CSV walk-through
--     Sold (5):    JUZ-647, KJF-926, 1205312, KLK-734, KLK-740
--     OOS  (3):    KAM-482, 1154437, KKA241
UPDATE "Vehicle"
SET    status = 'SOLD',
       "updatedAt" = NOW()
WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND  plate IN ('JUZ-647', 'KJF-926', '1205312', 'KLK-734', 'KLK-740');

UPDATE "Vehicle"
SET    status = 'OUT_OF_SERVICE',
       "updatedAt" = NOW()
WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND  plate IN ('KAM-482', '1154437', 'KKA241');

-- Sanity check the flip
SELECT plate, status, "internalNumber",
       year || ' ' || make || ' ' || model AS vehicle
FROM   "Vehicle"
WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND  status IN ('SOLD', 'OUT_OF_SERVICE')
ORDER BY status, plate;

-- 2b) Force check-in all overdue CHECKED_OUT reservations
--     "overdue" = returnAt < NOW. The 47 active per CSV (returnAt > NOW)
--     stay CHECKED_OUT.
--     We DON'T compute fees, don't write inspection rows, don't run
--     autocharge — this is a pure status flip with audit row.
WITH targets AS (
  SELECT r.id, r."reservationNumber", ra.id AS agreement_id, ra.balance
  FROM   "Reservation" r
  LEFT JOIN "RentalAgreement" ra ON ra."reservationId" = r.id
  WHERE  r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  r.status = 'CHECKED_OUT'
    AND  r."returnAt" < NOW()
),
res_updated AS (
  UPDATE "Reservation" r
  SET    status         = CASE
                            WHEN COALESCE(t.balance, 0) <= 0.01 THEN 'CHECKED_IN'
                            ELSE 'CHECKED_IN_UNPAID'
                          END,
         "autochargeAt" = NULL,
         "updatedAt"    = NOW()
  FROM   targets t
  WHERE  r.id = t.id
  RETURNING r.id, r.status, t.agreement_id, t.balance
),
ag_updated AS (
  -- For full-close (CHECKED_IN, $0 balance): also close + lock the agreement
  UPDATE "RentalAgreement" ra
  SET    status         = 'CLOSED',
         locked         = TRUE,
         "closedAt"     = NOW(),
         "updatedAt"    = NOW()
  FROM   res_updated u
  WHERE  ra.id = u.agreement_id
    AND  u.status = 'CHECKED_IN'
  RETURNING ra.id
)
SELECT
  (SELECT COUNT(*) FROM res_updated)                                  AS total_force_checked_in,
  (SELECT COUNT(*) FROM res_updated WHERE status = 'CHECKED_IN')      AS clean_close,
  (SELECT COUNT(*) FROM res_updated WHERE status = 'CHECKED_IN_UNPAID') AS balance_pending,
  (SELECT COUNT(*) FROM ag_updated)                                   AS agreements_closed;

-- 2c) Audit row per force-checkin
INSERT INTO "AuditLog" (id, "reservationId", "actorUserId", action,
                        "fromStatus", "toStatus", reason, metadata, "createdAt")
SELECT
  'log_' || substr(md5(random()::text || r.id), 1, 24),
  r.id, NULL, 'STATUS_CHANGE',
  'CHECKED_OUT', r.status,
  'Force check-in — physical lot walk reconciliation 2026-05-28. Vehicle returned; system was never closed out.',
  json_build_object(
    'forceCheckin', true,
    'inventoryReconciliation', '2026-05-28',
    'returnAtSnapshot', r."returnAt"
  )::text,
  NOW()
FROM   "Reservation" r
WHERE  r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND  r.status IN ('CHECKED_IN', 'CHECKED_IN_UNPAID')
  AND  r."updatedAt" >= NOW() - INTERVAL '2 minutes';

-- 2d) Mark NO_SHOW all overdue NEW/CONFIRMED reservations
WITH targets AS (
  SELECT id, status AS prev_status
  FROM   "Reservation"
  WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
    AND  status IN ('NEW', 'CONFIRMED')
    AND  "pickupAt" < NOW()
),
no_show_updated AS (
  UPDATE "Reservation" r
  SET    status      = 'NO_SHOW',
         "updatedAt" = NOW()
  FROM   targets t
  WHERE  r.id = t.id
  RETURNING r.id, t.prev_status
)
SELECT
  COUNT(*)                                              AS total_no_show,
  COUNT(*) FILTER (WHERE prev_status = 'NEW')           AS from_new,
  COUNT(*) FILTER (WHERE prev_status = 'CONFIRMED')     AS from_confirmed
FROM   no_show_updated;

-- 2e) Audit row per no-show
INSERT INTO "AuditLog" (id, "reservationId", "actorUserId", action,
                        "fromStatus", "toStatus", reason, metadata, "createdAt")
SELECT
  'log_' || substr(md5(random()::text || r.id), 1, 24),
  r.id, NULL, 'STATUS_CHANGE',
  NULL, 'NO_SHOW',
  'Bulk no-show — physical lot walk reconciliation 2026-05-28. Customer never picked up.',
  json_build_object(
    'noShowBulk', true,
    'inventoryReconciliation', '2026-05-28',
    'pickupAtSnapshot', r."pickupAt"
  )::text,
  NOW()
FROM   "Reservation" r
WHERE  r."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND  r.status = 'NO_SHOW'
  AND  r."updatedAt" >= NOW() - INTERVAL '2 minutes';

-- 2f) Final verify before commit
SELECT
  COUNT(*) FILTER (WHERE status = 'CHECKED_OUT' AND "returnAt" > NOW())                            AS active_target_47,
  COUNT(*) FILTER (WHERE status = 'CHECKED_OUT' AND "returnAt" <= NOW())                           AS still_stale_should_be_0,
  COUNT(*) FILTER (WHERE status IN ('NEW','CONFIRMED') AND "pickupAt" < NOW())                     AS still_no_show_should_be_0,
  COUNT(*) FILTER (WHERE status = 'CHECKED_IN')                                                    AS total_checked_in,
  COUNT(*) FILTER (WHERE status = 'CHECKED_IN_UNPAID')                                             AS total_unpaid_pending,
  COUNT(*) FILTER (WHERE status = 'NO_SHOW')                                                       AS total_no_show
FROM   "Reservation"
WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3';

SELECT
  status,
  COUNT(*) AS count
FROM   "Vehicle"
WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
GROUP BY status
ORDER BY count DESC;

-- If the numbers look right:
COMMIT;
-- otherwise:
-- ROLLBACK;


-- ---------------------------------------------------------------------
-- PASS 3 — Final sanity check (run on its own after PASS 2 commits)
-- ---------------------------------------------------------------------
-- Expected end state:
--   active_target_47         = 47   (the active rentals from your CSV)
--   still_stale_should_be_0  = 0
--   still_no_show_should_be_0= 0
--   SOLD                     = 5
--   OUT_OF_SERVICE           = 3 (plus any prior OOS)
--   AVAILABLE                = ~117 minus the prior 8 = depends on prior state
SELECT
  COUNT(*)                                                                            AS total_vehicles,
  COUNT(*) FILTER (WHERE status = 'AVAILABLE')                                        AS available,
  COUNT(*) FILTER (WHERE status = 'ON_RENT')                                          AS on_rent,
  COUNT(*) FILTER (WHERE status = 'IN_MAINTENANCE')                                   AS maintenance,
  COUNT(*) FILTER (WHERE status = 'OUT_OF_SERVICE')                                   AS out_of_service,
  COUNT(*) FILTER (WHERE status = 'SOLD')                                             AS sold,
  COUNT(*) FILTER (WHERE status NOT IN ('OUT_OF_SERVICE', 'SOLD'))                    AS effective_fleet
FROM   "Vehicle"
WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3';
