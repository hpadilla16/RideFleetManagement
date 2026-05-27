-- =====================================================================
-- RES-623949 — revert check-in back to CHECKED_OUT
-- Undoes everything checkin-close.service.js did so Hector can re-run
-- the wizard from scratch (and use the new Waive Late Return Fee toggle
-- after 8f3855b deploys).
--
-- What this undoes:
--   • reservation.status         CHECKED_IN → CHECKED_OUT
--   • reservation.autochargeAt   → null
--   • agreement.status           CLOSED → FINALIZED
--   • agreement.locked           true → false
--   • agreement.closedAt / closedByUserId → null
--   • agreement.odometerIn / fuelIn / cleanlinessIn → null
--   • RentalAgreementCharge rows where source LIKE 'FEE_ENGINE%'  → DELETE
--     (fuel refill + late return — both regenerated on re-checkin)
--   • RentalAgreementPayment $731.94 auto-charge → VOID
--     (kept as audit row, excluded from paidAmount rollup)
--   • RentalAgreementInspection where phase = CHECKIN → DELETE
--   • Recompute subtotal / taxes / fees / total / paidAmount / balance
--
-- What it KEEPS:
--   • RentalAgreementPayment $122.64 (original pre-checkin payment)
--   • All CHECKOUT-phase inspection rows + photos
--   • All AuditLog rows (STATUS_CHANGE history stays intact)
-- =====================================================================

BEGIN;

WITH target AS (
  SELECT ra.id AS agreement_id, r.id AS reservation_id
  FROM   "RentalAgreement" ra
  JOIN   "Reservation" r ON r.id = ra."reservationId"
  WHERE  r."reservationNumber" = 'RES-623949'
)
-- 1) Drop the FEE_ENGINE charges (fuel refill + the already-soft-deleted late fee)
DELETE FROM "RentalAgreementCharge" c
USING  target
WHERE  c."rentalAgreementId" = target.agreement_id
  AND  UPPER(COALESCE(c.source, '')) LIKE 'FEE_ENGINE%';

-- 2) Delete the CHECKIN inspection (CHECKOUT inspection stays)
DELETE FROM "RentalAgreementInspection" i
USING  "RentalAgreement" ra, "Reservation" r
WHERE  i."rentalAgreementId" = ra.id
  AND  ra."reservationId" = r.id
  AND  r."reservationNumber" = 'RES-623949'
  AND  i.phase = 'CHECKIN';

-- 3) Void the $731.94 auto-charge so it drops out of paidAmount
UPDATE "RentalAgreementPayment" p
SET    status     = 'VOID',
       notes      = COALESCE(p.notes || E'\n', '') ||
                    '[2026-05-27] Voided as part of check-in revert. Customer never paid this auto-charge; check-in will be re-run with the Waive Late Return Fee toggle.',
       "updatedAt" = NOW()
FROM   "RentalAgreement" ra, "Reservation" r
WHERE  p."rentalAgreementId" = ra.id
  AND  ra."reservationId" = r.id
  AND  r."reservationNumber" = 'RES-623949'
  AND  p.id = 'cmpol9k850007pc0tkgxdlqxu';

-- 4) Reset the agreement: unlock, clear close fields + read-in metrics
UPDATE "RentalAgreement" ra
SET    status         = 'FINALIZED',
       locked         = FALSE,
       "closedAt"     = NULL,
       "closedByUserId" = NULL,
       "odometerIn"   = NULL,
       "fuelIn"       = NULL,
       "cleanlinessIn" = NULL,
       "updatedAt"    = NOW()
FROM   "Reservation" r
WHERE  ra."reservationId" = r.id
  AND  r."reservationNumber" = 'RES-623949';

-- 5) Reset the reservation back to CHECKED_OUT
UPDATE "Reservation" r
SET    status         = 'CHECKED_OUT',
       "autochargeAt" = NULL,
       "updatedAt"    = NOW()
WHERE  r."reservationNumber" = 'RES-623949';

-- 6) Recompute agreement totals (mirrors recomputeAgreementTotals)
WITH target AS (
  SELECT ra.id
  FROM   "RentalAgreement" ra
  JOIN   "Reservation" r ON r.id = ra."reservationId"
  WHERE  r."reservationNumber" = 'RES-623949'
),
rollup AS (
  SELECT target.id AS rental_agreement_id,
    COALESCE(SUM(CASE
      WHEN UPPER(c."chargeType"::text) <> 'TAX'
       AND UPPER(COALESCE(c.source, '')) NOT LIKE 'FEE_ENGINE%'
      THEN c.total ELSE 0 END), 0)::numeric(10,2) AS subtotal,
    COALESCE(SUM(CASE
      WHEN UPPER(c."chargeType"::text) = 'TAX'
      THEN c.total ELSE 0 END), 0)::numeric(10,2) AS taxes,
    COALESCE(SUM(CASE
      WHEN UPPER(COALESCE(c.source, '')) LIKE 'FEE_ENGINE%'
      THEN c.total ELSE 0 END), 0)::numeric(10,2) AS fees
  FROM   target
  LEFT JOIN "RentalAgreementCharge" c
    ON c."rentalAgreementId" = target.id AND c.selected = TRUE
  GROUP BY target.id
),
paid AS (
  SELECT target.id AS rental_agreement_id,
         COALESCE(SUM(p.amount), 0)::numeric(10,2) AS paid_amount
  FROM   target
  LEFT JOIN "RentalAgreementPayment" p
    ON p."rentalAgreementId" = target.id AND p.status = 'PAID'
  GROUP BY target.id
)
UPDATE "RentalAgreement" ra
SET    subtotal     = rollup.subtotal,
       taxes        = rollup.taxes,
       fees         = rollup.fees,
       total        = (rollup.subtotal + rollup.taxes + rollup.fees)::numeric(10,2),
       "paidAmount" = paid.paid_amount,
       balance      = ((rollup.subtotal + rollup.taxes + rollup.fees) - paid.paid_amount)::numeric(10,2),
       "updatedAt"  = NOW()
FROM   rollup, paid
WHERE  ra.id = rollup.rental_agreement_id
  AND  ra.id = paid.rental_agreement_id;

-- 7) Verify
SELECT r."reservationNumber", r.status AS res_status, r."autochargeAt",
       ra."agreementNumber", ra.status AS ag_status, ra.locked,
       ra."closedAt", ra."odometerIn", ra."fuelIn", ra."cleanlinessIn",
       ra.subtotal, ra.taxes, ra.fees, ra.total,
       ra."paidAmount", ra.balance
FROM   "Reservation" r
JOIN   "RentalAgreement" ra ON ra."reservationId" = r.id
WHERE  r."reservationNumber" = 'RES-623949';

SELECT id, name, "chargeType", quantity, rate, total, selected, source, "sourceRefId"
FROM   "RentalAgreementCharge"
WHERE  "rentalAgreementId" IN (
         SELECT ra.id FROM "RentalAgreement" ra
         JOIN "Reservation" r ON r.id = ra."reservationId"
         WHERE r."reservationNumber" = 'RES-623949'
       )
ORDER BY "sortOrder", "createdAt";

SELECT id, method, amount, status, "paidAt", notes
FROM   "RentalAgreementPayment"
WHERE  "rentalAgreementId" IN (
         SELECT ra.id FROM "RentalAgreement" ra
         JOIN "Reservation" r ON r.id = ra."reservationId"
         WHERE r."reservationNumber" = 'RES-623949'
       )
ORDER BY "paidAt" DESC;

SELECT id, phase, "capturedAt"
FROM   "RentalAgreementInspection"
WHERE  "rentalAgreementId" IN (
         SELECT ra.id FROM "RentalAgreement" ra
         JOIN "Reservation" r ON r.id = ra."reservationId"
         WHERE r."reservationNumber" = 'RES-623949'
       )
ORDER BY "capturedAt";

-- Expected after revert:
--   res_status       = CHECKED_OUT
--   ag_status        = FINALIZED
--   locked           = false
--   closedAt         = null
--   odometerIn/fuelIn/cleanlinessIn = null
--   total            = 122.64
--   paidAmount       = 122.64
--   balance          = 0.00
--   1 charge row group (Daily/Service/Extension/Tax — no FEE_ENGINE rows)
--   1 PAID payment ($122.64); 1 VOID payment ($731.94)
--   1 inspection (CHECKOUT only)
COMMIT;
-- ROLLBACK;
