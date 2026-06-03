-- ════════════════════════════════════════════════════════════════════
-- Agreement ledger repair · 2026-06-03
-- The checkout wizard recorded payment rows but never updated
-- RentalAgreement.paidAmount / balance (fixed in beta.109). This repairs
-- agreements created TODAY via the new wizard. Run the PREVIEW first.
--
--   paidAmount = Σ RentalAgreementPayment (status PAID)
--   balance    = max(0, Σ selected non-deposit charges − paidAmount)
-- ════════════════════════════════════════════════════════════════════

-- ── 1 · PREVIEW: what would change ───────────────────────────────────
SELECT
  ra."agreementNumber",
  ra."paidAmount"  AS old_paid,
  sub.paid         AS new_paid,
  ra.balance       AS old_balance,
  GREATEST(0, sub.owed - sub.paid) AS new_balance
FROM "RentalAgreement" ra
JOIN (
  SELECT ra2.id,
    COALESCE((SELECT SUM(p.amount) FROM "RentalAgreementPayment" p
              WHERE p."rentalAgreementId" = ra2.id AND p.status = 'PAID'), 0) AS paid,
    COALESCE((SELECT SUM(c.total) FROM "RentalAgreementCharge" c
              WHERE c."rentalAgreementId" = ra2.id AND c.selected = true
                AND UPPER(COALESCE(c.source, '')) <> 'SECURITY_DEPOSIT'), 0) AS owed
  FROM "RentalAgreement" ra2
  WHERE ra2."createdAt" >= '2026-06-03'
) sub ON sub.id = ra.id
WHERE ra."paidAmount" IS DISTINCT FROM sub.paid
   OR ra.balance IS DISTINCT FROM GREATEST(0, sub.owed - sub.paid)
ORDER BY ra."agreementNumber";

-- ── 2 · APPLY (after eyeballing the preview) ─────────────────────────
UPDATE "RentalAgreement" ra
SET "paidAmount" = sub.paid,
    balance      = GREATEST(0, sub.owed - sub.paid)
FROM (
  SELECT ra2.id,
    COALESCE((SELECT SUM(p.amount) FROM "RentalAgreementPayment" p
              WHERE p."rentalAgreementId" = ra2.id AND p.status = 'PAID'), 0) AS paid,
    COALESCE((SELECT SUM(c.total) FROM "RentalAgreementCharge" c
              WHERE c."rentalAgreementId" = ra2.id AND c.selected = true
                AND UPPER(COALESCE(c.source, '')) <> 'SECURITY_DEPOSIT'), 0) AS owed
  FROM "RentalAgreement" ra2
  WHERE ra2."createdAt" >= '2026-06-03'
) sub
WHERE ra.id = sub.id
  AND (ra."paidAmount" IS DISTINCT FROM sub.paid
       OR ra.balance IS DISTINCT FROM GREATEST(0, sub.owed - sub.paid));
