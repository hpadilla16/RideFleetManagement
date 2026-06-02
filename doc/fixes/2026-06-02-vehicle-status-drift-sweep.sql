-- =====================================================================
-- One-time Vehicle.status reconciliation sweep (bug #44 cleanup)
-- 2026-06-02
--
-- Run this AFTER v0.9.0-beta.61 is deployed. The new code keeps Vehicle.status
-- in step going forward; this corrects rows that already drifted before it.
--
-- Truth model (matches vehicle-status-sync.js):
--   A non-locked vehicle is ON_RENT iff it has a reservation in status
--   CHECKED_OUT; otherwise it should be AVAILABLE.
--
-- This sweep only fixes the two UNAMBIGUOUS drift cases:
--   A) has a CHECKED_OUT reservation but is NOT ON_RENT   -> ON_RENT
--   B) is ON_RENT but has NO CHECKED_OUT reservation       -> AVAILABLE
--
-- It deliberately does NOT touch:
--   - IN_MAINTENANCE / OUT_OF_SERVICE / SOLD  (locked operational states)
--   - RESERVED vehicles with no checkout       (could be a deliberate hold)
--
-- Scope: ALL tenants. Review PASS 1 (diagnostic) before running PASS 2.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PASS 1 — DIAGNOSTIC (read-only). What would change, and why.
-- ---------------------------------------------------------------------
WITH checked_out AS (
  SELECT DISTINCT "vehicleId" AS vid
  FROM   "Reservation"
  WHERE  status = 'CHECKED_OUT' AND "vehicleId" IS NOT NULL
)
SELECT v."tenantId",
       v.plate,
       v."internalNumber",
       v.status                                   AS current_status,
       CASE WHEN co.vid IS NOT NULL THEN 'ON_RENT' ELSE 'AVAILABLE' END AS correct_status,
       CASE
         WHEN co.vid IS NOT NULL THEN 'A: has CHECKED_OUT res -> ON_RENT'
         ELSE 'B: no CHECKED_OUT res -> AVAILABLE'
       END                                         AS reason
FROM   "Vehicle" v
LEFT JOIN checked_out co ON co.vid = v.id
WHERE  (
         -- case A: should be ON_RENT but isn't
         (co.vid IS NOT NULL AND v.status IN ('AVAILABLE', 'RESERVED'))
         -- case B: is ON_RENT but shouldn't be
         OR (co.vid IS NULL AND v.status = 'ON_RENT')
       )
ORDER BY v."tenantId", v.plate;


-- ---------------------------------------------------------------------
-- PASS 2 — FIX (run as one transaction after reviewing PASS 1)
-- ---------------------------------------------------------------------
BEGIN;

-- A) Rented cars that aren't marked ON_RENT (currently AVAILABLE or RESERVED).
UPDATE "Vehicle" v
SET    status = 'ON_RENT',
       "updatedAt" = NOW()
WHERE  v.status IN ('AVAILABLE', 'RESERVED')
  AND  EXISTS (
         SELECT 1 FROM "Reservation" r
         WHERE r."vehicleId" = v.id AND r.status = 'CHECKED_OUT'
       );

-- B) Stuck ON_RENT cars with no active checkout — release them.
UPDATE "Vehicle" v
SET    status = 'AVAILABLE',
       "updatedAt" = NOW()
WHERE  v.status = 'ON_RENT'
  AND  NOT EXISTS (
         SELECT 1 FROM "Reservation" r
         WHERE r."vehicleId" = v.id AND r.status = 'CHECKED_OUT'
       );

-- VERIFY — this should return ZERO rows after the fix (no remaining drift).
WITH checked_out AS (
  SELECT DISTINCT "vehicleId" AS vid
  FROM   "Reservation"
  WHERE  status = 'CHECKED_OUT' AND "vehicleId" IS NOT NULL
)
SELECT v."tenantId", v.plate, v.status AS current_status,
       CASE WHEN co.vid IS NOT NULL THEN 'ON_RENT' ELSE 'AVAILABLE' END AS correct_status
FROM   "Vehicle" v
LEFT JOIN checked_out co ON co.vid = v.id
WHERE  (co.vid IS NOT NULL AND v.status IN ('AVAILABLE', 'RESERVED'))
   OR  (co.vid IS NULL AND v.status = 'ON_RENT')
ORDER BY v."tenantId", v.plate;

COMMIT;
-- ROLLBACK;  -- swap COMMIT for ROLLBACK to dry-run first
