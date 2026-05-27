-- =====================================================================
-- Follow-up for RES-623949
-- The agreement currently shows a $675 credit balance because the late
-- fee was removed but the phantom payment (auto-charge for the late
-- fee + extra) is still in RentalAgreementPayment as PAID. Customer
-- never actually paid that. Mark the phantom payment(s) as VOID so it
-- drops out of paidAmount, then recompute totals.
--
-- NOTE: run section 1 first to inspect the payments. Identify which
-- row(s) make up the $675 you want to remove, then run section 2 (and
-- adjust the WHERE clause if you need to target a specific payment id).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Inspect all payments on this agreement. Look for the line(s) that
--    correspond to the auto-charged late fee — typically the most
--    recent payments around the close timestamp.
-- ---------------------------------------------------------------------
SELECT p.id, p.method, p.amount, p.status, p."paidAt",
       p.reference, p.notes, p."createdAt"
FROM   "RentalAgreementPayment" p
JOIN   "RentalAgreement" ra ON ra.id = p."rentalAgreementId"
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  r."reservationNumber" = 'RES-623949'
ORDER BY p."paidAt" DESC, p."createdAt" DESC;


-- ---------------------------------------------------------------------
-- 2) Void the phantom payment(s) and recompute the agreement.
--    The WHERE filter below voids any PAID payment of exactly $650.00.
--    If your inspection shows a single row of $675 (late fee + deposit)
--    or a different amount, change the `amount = 650.00` line to match
--    the actual phantom row, or target it by id:
--       AND p.id = '<paste-payment-id-here>'
-- ---------------------------------------------------------------------
BEGIN;

-- 2a) Void the phantom payment(s)
UPDATE "RentalAgreementPayment" p
SET    status    = 'VOID',
       notes     = COALESCE(p.notes || E'\n', '') ||
                   '[2026-05-27] Voided: late-fee auto-charge reversed — customer never paid this; late fee was billed against the pre-extension dueBack date.',
       "updatedAt" = NOW()
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  p."rentalAgreementId" = ra.id
  AND  r."reservationNumber" = 'RES-623949'
  AND  p.status = 'PAID'
  AND  p.amount = 650.00;   -- <-- adjust if inspection shows a different amount

-- 2b) Recompute paidAmount + balance (mirrors recomputeAgreementTotals)
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

-- 2c) Verify
SELECT ra.id, ra."agreementNumber",
       ra.subtotal, ra.taxes, ra.fees, ra.total,
       ra."paidAmount", ra.balance
FROM   "RentalAgreement" ra
JOIN   "Reservation" r ON r.id = ra."reservationId"
WHERE  r."reservationNumber" = 'RES-623949';

SELECT id, method, amount, status, "paidAt", notes
FROM   "RentalAgreementPayment"
WHERE  "rentalAgreementId" IN (
         SELECT ra.id FROM "RentalAgreement" ra
         JOIN "Reservation" r ON r.id = ra."reservationId"
         WHERE r."reservationNumber" = 'RES-623949'
       )
ORDER BY "paidAt" DESC;

-- If numbers look correct (balance should be ~ $0 if you removed
-- exactly the late-fee payment):
COMMIT;
-- otherwise:
-- ROLLBACK;
