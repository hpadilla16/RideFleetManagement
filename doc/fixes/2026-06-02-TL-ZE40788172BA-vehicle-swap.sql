-- =====================================================================
-- TL-ZE40788172BA — correct wrong-unit checkout: KST787 -> KST788
-- 2026-06-02
--
-- WHAT HAPPENED
--   The customer physically drove off in the Mirage KST788 / UNIT-100
--   (confirmed by Hector 2026-06-02), but at checkout KST788 was showing
--   ON_RENT (stale Vehicle.status, bug #44 — its prior rental RES-012328
--   was checked in May 30 but the status never flipped back), so the agent
--   recorded the checkout against KST787 / UNIT-099 instead.
--
--   Result in prod (verified via diagnostic):
--     • Reservation TL-ZE40788172BA  -> vehicleId = KST787   (WRONG)
--     • RentalAgreement RA-20260601191145-2821 -> vehicleId = KST787 (WRONG)
--     • Vehicle KST787  status = AVAILABLE  (WRONG — it holds a live res)
--     • Vehicle KST788  status = ON_RENT    (right car, but nothing points
--                                            to it; flipped on June 1)
--
-- WHAT THIS FIX DOES (mirrors the supported swap-vehicle path)
--     1. Reservation.vehicleId        KST787 -> KST788
--     2. RentalAgreement.vehicleId    KST787 -> KST788
--     3. Insert a RentalAgreementVehicleSwap audit row
--     4. Vehicle KST788  status -> ON_RENT     (now correctly attributed;
--                                               rental runs until 2026-06-12)
--     5. Vehicle KST787  status -> AVAILABLE   (no active rental remains)
--
--   NOTE: reservation window is unchanged (pickup 2026-06-01 19:00,
--   return 2026-06-12 19:00). There is NO June-2-2pm hold in the data;
--   the "unavailable" symptom was the stale ON_RENT status above.
--
--   Every UPDATE is guarded on the expected current vehicleId so this is
--   safe to re-run (idempotent) and won't fire against unexpected state.
--
-- Tenant: International Rental Corp (IRC) = cmn98hc1u0085ke0i4vefujt3
-- Known ids (from diagnostic):
--   reservation     cmptt3gb8001boh017gkjxdt2  (TL-ZE40788172BA)
--   agreement       cmpvl4l4o001unx0rocg84qb7  (RA-20260601191145-2821)
--   KST787 / UNIT-099  cmnajz1eq005tm80izm69kxk0  (FROM)
--   KST788 / UNIT-100  cmnajz1f2005vm80iczn7iqce  (TO)
-- =====================================================================

BEGIN;

-- 1) Move the reservation onto the correct unit (KST788)
UPDATE "Reservation"
SET    "vehicleId" = 'cmnajz1f2005vm80iczn7iqce',   -- KST788
       "updatedAt" = NOW()
WHERE  "reservationNumber" = 'TL-ZE40788172BA'
  AND  "vehicleId" = 'cmnajz1eq005tm80izm69kxk0';   -- guard: only if still KST787

-- 2) Move the active rental agreement onto KST788
UPDATE "RentalAgreement"
SET    "vehicleId" = 'cmnajz1f2005vm80iczn7iqce',   -- KST788
       "updatedAt" = NOW()
WHERE  id = 'cmpvl4l4o001unx0rocg84qb7'             -- RA-20260601191145-2821
  AND  "vehicleId" = 'cmnajz1eq005tm80izm69kxk0';   -- guard: only if still KST787

-- 3) Audit trail — record the correction as a vehicle swap.
--    Skips itself on re-run (NOT EXISTS guard on the deterministic id).
INSERT INTO "RentalAgreementVehicleSwap"
       (id, "rentalAgreementId",
        "actorUserId",
        "previousVehicleId",  "previousVehicleLabel",
        "nextVehicleId",      "nextVehicleLabel",
        note,
        "createdAt", "updatedAt")
SELECT 'fixswap_tlze40788172ba_20260602',
       'cmpvl4l4o001unx0rocg84qb7',
       NULL,
       'cmnajz1eq005tm80izm69kxk0', 'KST787 / UNIT-099',
       'cmnajz1f2005vm80iczn7iqce', 'KST788 / UNIT-100',
       'Manual correction (2026-06-02): checkout was recorded against KST787 '
       || 'but the customer physically took KST788. KST788 showed ON_RENT at '
       || 'checkout (stale status, bug #44) so the agent picked KST787. '
       || 'Reservation + agreement moved to KST788; KST787 released.',
       NOW(), NOW()
WHERE  NOT EXISTS (
         SELECT 1 FROM "RentalAgreementVehicleSwap"
         WHERE id = 'fixswap_tlze40788172ba_20260602'
       );

-- 4) KST788 is the rented car now — make the status say so explicitly.
UPDATE "Vehicle"
SET    status = 'ON_RENT',
       "updatedAt" = NOW()
WHERE  id = 'cmnajz1f2005vm80iczn7iqce'             -- KST788
  AND  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3';

-- 5) KST787 has no active rental left — release it back to the lot.
--    Guarded so we never free a car that has some OTHER active rental.
UPDATE "Vehicle" v
SET    status = 'AVAILABLE',
       "updatedAt" = NOW()
WHERE  v.id = 'cmnajz1eq005tm80izm69kxk0'           -- KST787
  AND  v."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND  NOT EXISTS (
         SELECT 1 FROM "Reservation" r
         WHERE r."vehicleId" = v.id
           AND r.status IN ('CHECKED_OUT', 'CHECKED_IN_UNPAID')
       );

-- ---------------------------------------------------------------------
-- VERIFY (expected results in comments)
-- ---------------------------------------------------------------------

-- Reservation + agreement should now both read KST788 / UNIT-100
SELECT r."reservationNumber", r.status AS res_status,
       rv.plate AS res_plate, rv."internalNumber" AS res_unit,
       ra."agreementNumber", ra.status AS ag_status,
       av.plate AS ag_plate, av."internalNumber" AS ag_unit,
       r."pickupAt", r."returnAt"
FROM   "Reservation" r
JOIN   "Vehicle" rv ON rv.id = r."vehicleId"
JOIN   "RentalAgreement" ra ON ra."reservationId" = r.id
JOIN   "Vehicle" av ON av.id = ra."vehicleId"
WHERE  r."reservationNumber" = 'TL-ZE40788172BA';
-- expect: res_plate = ag_plate = KST788, both = UNIT-100

-- Both vehicles' statuses
SELECT plate, "internalNumber", status, "updatedAt"
FROM   "Vehicle"
WHERE  id IN ('cmnajz1eq005tm80izm69kxk0', 'cmnajz1f2005vm80iczn7iqce')
ORDER BY plate;
-- expect: KST787 = AVAILABLE, KST788 = ON_RENT

-- The audit row
SELECT id, "previousVehicleLabel", "nextVehicleLabel", note, "createdAt"
FROM   "RentalAgreementVehicleSwap"
WHERE  id = 'fixswap_tlze40788172ba_20260602';
-- expect: 1 row, KST787 / UNIT-099  ->  KST788 / UNIT-100

COMMIT;
-- ROLLBACK;  -- swap COMMIT for ROLLBACK to dry-run inside the txn first
