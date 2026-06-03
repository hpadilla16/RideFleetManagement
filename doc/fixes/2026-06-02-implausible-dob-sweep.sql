-- =====================================================================
-- Find (and optionally clear) implausible dates of birth.
-- Companion to the DOB-sanitizer fix (beta.65). Incident: TL-ZE40789836BA
-- had Customer.dateOfBirth = 2800-04-01 and RentalAgreement.dateOfBirth =
-- 0959-04-01, which made the checkout age gate compute age ~1067 and block.
--
-- "Implausible" = year < 1900, OR a future date, OR computed age > 120.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PASS 1 — DIAGNOSTIC (read-only). Who else has a garbage DOB?
-- ---------------------------------------------------------------------
SELECT 'Customer' AS tbl,
       c.id, c."firstName", c."lastName",
       c."dateOfBirth",
       date_part('year', age(c."dateOfBirth")) AS computed_age
FROM   "Customer" c
WHERE  c."dateOfBirth" IS NOT NULL
  AND  ( extract(year from c."dateOfBirth") < 1900
         OR c."dateOfBirth" > now()
         OR date_part('year', age(c."dateOfBirth")) > 120 )
ORDER BY c."dateOfBirth";

SELECT 'RentalAgreement' AS tbl,
       ra.id, ra."agreementNumber", r."reservationNumber",
       ra."dateOfBirth",
       date_part('year', age(ra."dateOfBirth")) AS computed_age
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  ra."dateOfBirth" IS NOT NULL
  AND  ( extract(year from ra."dateOfBirth") < 1900
         OR ra."dateOfBirth" > now()
         OR date_part('year', age(ra."dateOfBirth")) > 120 )
ORDER BY ra."dateOfBirth";


-- ---------------------------------------------------------------------
-- PASS 2 — CLEANUP (optional). Null out the impossible DOBs so the agent
-- re-enters them from the license at checkout. The year is unrecoverable
-- from a garbage value, so NULL is the safe correction. Review PASS 1 first.
-- (If you already know a customer's real DOB — e.g. Tyrone Mahee — fix that
--  one directly with the dated UPDATEs from the counter hotfix instead.)
-- ---------------------------------------------------------------------
-- BEGIN;
--
-- UPDATE "Customer"
-- SET    "dateOfBirth" = NULL, "updatedAt" = NOW()
-- WHERE  "dateOfBirth" IS NOT NULL
--   AND  ( extract(year from "dateOfBirth") < 1900
--          OR "dateOfBirth" > now()
--          OR date_part('year', age("dateOfBirth")) > 120 );
--
-- UPDATE "RentalAgreement"
-- SET    "dateOfBirth" = NULL
-- WHERE  "dateOfBirth" IS NOT NULL
--   AND  ( extract(year from "dateOfBirth") < 1900
--          OR "dateOfBirth" > now()
--          OR date_part('year', age("dateOfBirth")) > 120 );
--
-- -- verify PASS 1 now returns zero rows
-- COMMIT;
-- ROLLBACK;
