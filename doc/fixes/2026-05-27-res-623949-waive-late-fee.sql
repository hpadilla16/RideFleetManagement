-- =====================================================================
-- One-off fix for RES-623949
-- Late-return fee ($650) was charged even though the customer had
-- already extended the rental. Soft-delete the LATE_RETURN charge and
-- recompute the agreement totals + balance using the same logic as
-- recomputeAgreementTotals() in fee-engine.service.js.
-- =====================================================================

BEGIN;

-- 1) Look up the agreement (sanity check; no-op if nothing returned)
SELECT ra.id, ra."agreementNumber", ra.status,
       ra.subtotal, ra.taxes, ra.fees, ra.total,
       ra."paidAmount", ra.balance
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  r."reservationNumber" = 'RES-623949';

-- 2) See the LATE_RETURN line we are about to remove
SELECT id, name, total, selected, source, "sourceRefId", "createdAt"
FROM   "RentalAgreementCharge"
WHERE  "rentalAgreementId" IN (
         SELECT ra.id FROM "RentalAgreement" ra
         JOIN "Reservation" r ON r.id = ra."reservationId"
         WHERE r."reservationNumber" = 'RES-623949'
       )
  AND  "sourceRefId" = 'LATE_RETURN';

-- 3) Soft-delete (preserves audit trail; UI/rollups all filter selected=true)
UPDATE "RentalAgreementCharge" c
SET    selected = FALSE,
       "updatedAt" = NOW()
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  c."rentalAgreementId" = ra.id
  AND  r."reservationNumber" = 'RES-623949'
  AND  c."sourceRefId" = 'LATE_RETURN'
  AND  c.selected = TRUE;

-- 4) Recompute subtotal / taxes / fees / total / paidAmount / balance
--    mirroring backend/src/modules/fees/fee-engine.service.js:recomputeAgreementTotals
WITH target AS (
  SELECT ra.id
  FROM   "RentalAgreement" ra
  JOIN   "Reservation" r ON r.id = ra."reservationId"
  WHERE  r."reservationNumber" = 'RES-623949'
),
rollup AS (
  SELECT
    target.id AS rental_agreement_id,
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
  SELECT
    target.id AS rental_agreement_id,
    COALESCE(SUM(p.amount), 0)::numeric(10,2) AS paid_amount
  FROM   target
  LEFT JOIN "RentalAgreementPayment" p
    ON p."rentalAgreementId" = target.id AND p.status = 'PAID'
  GROUP BY target.id
)
UPDATE "RentalAgreement" ra
SET    subtotal    = rollup.subtotal,
       taxes       = rollup.taxes,
       fees        = rollup.fees,
       total       = (rollup.subtotal + rollup.taxes + rollup.fees)::numeric(10,2),
       "paidAmount" = paid.paid_amount,
       balance     = ((rollup.subtotal + rollup.taxes + rollup.fees) - paid.paid_amount)::numeric(10,2),
       "updatedAt" = NOW()
FROM   rollup, paid
WHERE  ra.id = rollup.rental_agreement_id
  AND  ra.id = paid.rental_agreement_id;

-- 5) Verify the new numbers BEFORE committing
SELECT ra.id, ra."agreementNumber", ra.status,
       ra.subtotal, ra.taxes, ra.fees, ra.total,
       ra."paidAmount", ra.balance
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  r."reservationNumber" = 'RES-623949';

SELECT id, name, total, selected, source, "sourceRefId"
FROM   "RentalAgreementCharge"
WHERE  "rentalAgreementId" IN (
         SELECT ra.id FROM "RentalAgreement" ra
         JOIN "Reservation" r ON r.id = ra."reservationId"
         WHERE r."reservationNumber" = 'RES-623949'
       )
ORDER BY "sortOrder", "createdAt";

-- If the numbers look right:
COMMIT;
-- otherwise:
-- ROLLBACK;
