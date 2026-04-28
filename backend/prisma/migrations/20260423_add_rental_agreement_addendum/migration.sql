-- Rental agreement addendum — BUG-001 Option C (addendum flow).
-- Parent RentalAgreement stays immutable; date changes post-signature
-- create a new addendum row with its own signature lifecycle.

CREATE TABLE IF NOT EXISTS "RentalAgreementAddendum" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "rentalAgreementId" TEXT NOT NULL,
  "tenantId" TEXT,
  "pickupAt" TIMESTAMP(3) NOT NULL,
  "returnAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "reasonCategory" TEXT DEFAULT 'admin_correction',
  "initiatedBy" TEXT,
  "initiatedByRole" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING_SIGNATURE',
  "signatureSignedBy" TEXT,
  "signatureDataUrl" TEXT,
  "signatureSignedAt" TIMESTAMP(3),
  "signatureIp" TEXT,
  "originalCharges" TEXT,
  "newCharges" TEXT,
  "chargeDelta" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RentalAgreementAddendum_rentalAgreementId_fkey" FOREIGN KEY ("rentalAgreementId") REFERENCES "RentalAgreement" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RentalAgreementAddendum_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RentalAgreementAddendum_rentalAgreementId_idx" ON "RentalAgreementAddendum"("rentalAgreementId");
CREATE INDEX IF NOT EXISTS "RentalAgreementAddendum_tenantId_status_idx" ON "RentalAgreementAddendum"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "RentalAgreementAddendum_status_createdAt_idx" ON "RentalAgreementAddendum"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "RentalAgreementAddendum_tenantId_createdAt_idx" ON "RentalAgreementAddendum"("tenantId", "createdAt");
