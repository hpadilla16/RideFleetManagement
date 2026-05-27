-- =====================================================================
-- RES-623949 — refund the $650 phantom late fee
-- The post-checkin auto-charge (cmpol9k850007pc0tkgxdlqxu, $731.94)
-- bundled the legitimate fuel refill + the phantom late fee. Don't
-- touch the original payment row — it matches the processor record.
-- Instead insert a negative-amount refund line so the rollup nets out.
-- =====================================================================

BEGIN;

-- 1) Insert the refund line
INSERT INTO "RentalAgreementPayment"
  (id, "rentalAgreementId", method, amount, reference, status, "paidAt", notes, "createdAt", "updatedAt")
SELECT
  'pay_' || substr(md5(random()::text), 1, 24),  -- ad-hoc id; matches cuid-ish length
  ra.id,
  'CARD'::"AgreementPaymentMethod",
  -650.00,
  'REFUND of cmpol9k850007pc0tkgxdlqxu',
  'PAID'::"PaymentStatus",
  NOW(),
  '[2026-05-27] Refund $650 — late-return fee waived. Original $731.94 auto-charge ran against pre-extension dueBack and double-counted late hours after the customer had already extended. Refund issued externally via processor.',
  NOW(),
  NOW()
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  r."reservationNumber" = 'RES-623949';

-- 2) Recompute paidAmount + balance
WITH target AS (
  SELECT ra.id
  FROM   "RentalAgreement" ra
  JOIN   "Reservation" r ON r.id = ra."reservationId"
  WHERE  r."reservationNumber" = 'RES-623949'
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
SET    "paidAmount" = paid.paid_amount,
       balance      = (ra.total - paid.paid_amount)::numeric(10,2),
       "updatedAt"  = NOW()
FROM   paid
WHERE  ra.id = paid.rental_agreement_id;

-- 3) Verify
SELECT ra."agreementNumber",
       ra.subtotal, ra.taxes, ra.fees, ra.total,
       ra."paidAmount", ra.balance
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  r."reservationNumber" = 'RES-623949';

SELECT id, method, amount, status, "paidAt", reference, notes
FROM   "RentalAgreementPayment"
WHERE  "rentalAgreementId" IN (
         SELECT ra.id FROM "RentalAgreement" ra
         JOIN "Reservation" r ON r.id = ra."reservationId"
         WHERE r."reservationNumber" = 'RES-623949'
       )
ORDER BY "paidAt" DESC;

COMMIT;
-- ROLLBACK;
