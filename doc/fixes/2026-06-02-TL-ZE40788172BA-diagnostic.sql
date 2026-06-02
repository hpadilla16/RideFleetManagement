-- =====================================================================
-- DIAGNOSTIC (read-only) — TL-ZE40788172BA wrong-vehicle / stuck KST788
-- 2026-06-02
--
-- Reported symptom (Hector):
--   • TL-ZE40788172BA was checked out on KST787 but SHOULD be on KST788
--     (Mitsubishi Mirage). KST788 looked busy at checkout because a prior
--     rental of it was never checked in, so the agent grabbed KST787.
--   • KST788 has since been checked in, but it still shows unavailable
--     "because the reservation is until June 2 at 2pm".
--
-- This script ONLY reads. It mutates nothing. Run it, paste the output
-- back, and the fix SQL will be written against the real ids/state.
--
-- Tenant: International Rental Corp (IRC) = cmn98hc1u0085ke0i4vefujt3
-- =====================================================================

-- 1) The reservation in question + its active rental agreement
SELECT r.id                AS reservation_id,
       r."reservationNumber",
       r.status            AS res_status,
       r."vehicleId"       AS res_vehicle_id,
       v.plate             AS res_vehicle_plate,
       v."internalNumber"  AS res_vehicle_internal,
       v.make, v.model,
       r."pickupAt", r."returnAt", r."originalReturnAt",
       r."overdueIgnored",
       ra.id               AS agreement_id,
       ra."agreementNumber",
       ra.status           AS ag_status,
       ra."vehicleId"      AS ag_vehicle_id,
       av.plate            AS ag_vehicle_plate,
       ra."closedAt", ra.locked
FROM   "Reservation" r
LEFT JOIN "Vehicle" v        ON v.id  = r."vehicleId"
LEFT JOIN "RentalAgreement" ra ON ra."reservationId" = r.id
LEFT JOIN "Vehicle" av       ON av.id = ra."vehicleId"
WHERE  r."reservationNumber" = 'TL-ZE40788172BA';

-- 2) Both vehicles by plate (try with and without a dash / leading match).
--    Confirms ids, current status, and which is the Mirage.
SELECT id, "tenantId", plate, "internalNumber", make, model, year,
       status, "vehicleTypeId", "updatedAt"
FROM   "Vehicle"
WHERE  "tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND  (
        replace(plate, '-', '') IN ('KST787', 'KST788')
        OR "internalNumber" IN ('KST787', 'KST788')
       )
ORDER BY plate;

-- 3) ANY reservation currently holding KST787 or KST788 that overlaps now.
--    This is what makes a plate "show unavailable until <returnAt>".
--    NEW/CONFIRMED/CHECKED_OUT with returnAt in the future = active hold.
SELECT r."reservationNumber",
       r.status,
       v.plate,
       r."pickupAt", r."returnAt",
       r."overdueIgnored",
       ra.id AS agreement_id, ra.status AS ag_status, ra."closedAt"
FROM   "Reservation" r
JOIN   "Vehicle" v ON v.id = r."vehicleId"
LEFT JOIN "RentalAgreement" ra ON ra."reservationId" = r.id
WHERE  v."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND  replace(v.plate, '-', '') IN ('KST787', 'KST788')
ORDER BY v.plate, r."returnAt" DESC;

-- 4) Any availability blocks on these vehicles (migration holds etc.)
SELECT b.id, v.plate, b."blockType", b."blockedFrom", b."availableFrom",
       b."releasedAt", b.reason, b.notes
FROM   "VehicleAvailabilityBlock" b
JOIN   "Vehicle" v ON v.id = b."vehicleId"
WHERE  v."tenantId" = 'cmn98hc1u0085ke0i4vefujt3'
  AND  replace(v.plate, '-', '') IN ('KST787', 'KST788')
ORDER BY v.plate, b."blockedFrom" DESC;

-- 5) Existing vehicle-swap audit rows on this agreement (so we don't dup)
SELECT s.id, s."rentalAgreementId", s."previousVehicleLabel",
       s."nextVehicleLabel", s.note, s."createdAt"
FROM   "RentalAgreementVehicleSwap" s
JOIN   "RentalAgreement" ra ON ra.id = s."rentalAgreementId"
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  r."reservationNumber" = 'TL-ZE40788172BA'
ORDER BY s."createdAt" DESC;
