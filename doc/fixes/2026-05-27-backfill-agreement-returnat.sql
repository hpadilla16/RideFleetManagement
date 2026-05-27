-- =====================================================================
-- Backfill: sync RentalAgreement.returnAt with Reservation.returnAt
-- for every reservation that was ever extended.
--
-- Before today, reservation-extend.service.js updated reservation.returnAt
-- but never touched the matching agreement.returnAt. That caused the
-- late-fee engine in checkin-close.service.js to read the stale
-- pre-extension dueBack, which billed phantom LATE_RETURN charges (the
-- RES-623949 $650 incident). The forward fix is committed; this script
-- repairs historical data.
--
-- Run in two passes:
--   1) DRY RUN — see which agreements would be touched + the deltas
--   2) APPLY  — wrap in BEGIN/COMMIT and update for real
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) DRY RUN — identify drifted rows
-- ---------------------------------------------------------------------
SELECT
  r."reservationNumber",
  r.status                       AS reservation_status,
  ra."agreementNumber",
  ra.status                      AS agreement_status,
  ra."returnAt"                  AS agreement_return_at,
  r."returnAt"                   AS reservation_return_at,
  r."originalReturnAt",
  EXTRACT(EPOCH FROM (r."returnAt" - ra."returnAt"))/3600 AS hours_drift
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  r."returnAt" <> ra."returnAt"
ORDER BY r."returnAt" DESC;

-- ---------------------------------------------------------------------
-- 2) APPLY — sync agreement.returnAt to reservation.returnAt for all
--    drifted rows. Reservation is the source of truth (the UI, public
--    portal, and reservation-extend.service.js all write here first).
--
--    NB: only touches agreements where the values differ. CLOSED
--    agreements get repaired too — they shouldn't have drifted but if
--    they did, the late-fee already fired against the stale date and
--    it's better to have history reflect reality than to leave a
--    misleading agreement.returnAt sitting in the database forever.
-- ---------------------------------------------------------------------
BEGIN;

UPDATE "RentalAgreement" ra
SET    "returnAt"  = r."returnAt",
       "updatedAt" = NOW()
FROM   "Reservation" r
WHERE  ra."reservationId" = r.id
  AND  ra."returnAt" <> r."returnAt";

-- Verify nothing is drifted anymore
SELECT COUNT(*) AS still_drifted
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  r."returnAt" <> ra."returnAt";  -- expect 0

COMMIT;
-- ROLLBACK;
