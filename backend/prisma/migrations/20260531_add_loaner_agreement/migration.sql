-- Loaner Program reimagining (2026-05-31). Adds the dedicated LoanerAgreement
-- entity + LoanerPhoto + LoanerDamagePoint for the in-bay service-loaner
-- wizard, mirroring the RentalAgreement family. Reservation
-- (workflowMode = DEALERSHIP_LOANER) stays the lifecycle anchor.
--
-- Additive only — no existing column/table is altered. Idempotent: safe to
-- re-run, and safe to paste directly into the Supabase SQL editor (we apply
-- via the SQL editor because `prisma db push` hangs on the pgbouncer pooler).
--
-- Plan: doc/loaner-reimagining-plan-2026-05-31.md

-- 1. Enums (idempotent via pg_type guard) -----------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoanerAgreementStatus') THEN
    CREATE TYPE "LoanerAgreementStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETURNED', 'CLOSED', 'VOID');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoanerPhotoKind') THEN
    CREATE TYPE "LoanerPhotoKind" AS ENUM ('WALKAROUND_OUT', 'WALKAROUND_IN', 'DAMAGE', 'FUEL_OUT', 'FUEL_IN', 'ODOMETER_OUT', 'ODOMETER_IN', 'LICENSE', 'INSURANCE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoanerDamageSeverity') THEN
    CREATE TYPE "LoanerDamageSeverity" AS ENUM ('MINOR', 'MODERATE', 'SEVERE');
  END IF;
END $$;

-- 2. LoanerAgreement --------------------------------------------------------
CREATE TABLE IF NOT EXISTS "LoanerAgreement" (
  "id"                      TEXT NOT NULL,
  "tenantId"                TEXT,
  "agreementNumber"         TEXT NOT NULL,
  "status"                  "LoanerAgreementStatus" NOT NULL DEFAULT 'DRAFT',
  "reservationId"           TEXT NOT NULL,
  "vehicleId"               TEXT,
  "pickupAt"                TIMESTAMP(3) NOT NULL,
  "returnAt"                TIMESTAMP(3) NOT NULL,
  "customerFirstName"       TEXT NOT NULL,
  "customerLastName"        TEXT NOT NULL,
  "customerEmail"           TEXT,
  "customerPhone"           TEXT,
  "dateOfBirth"             TIMESTAMP(3),
  "licenseNumber"           TEXT,
  "licenseState"            TEXT,
  "licenseExpiry"           TIMESTAMP(3),
  "licenseImagePath"        TEXT,
  "insuranceCarrier"        TEXT,
  "insurancePolicyNumber"   TEXT,
  "insuranceEffective"      TIMESTAMP(3),
  "insuranceExpiry"         TIMESTAMP(3),
  "insuranceImagePath"      TEXT,
  "fuelOut"                 DECIMAL(4,2),
  "fuelIn"                  DECIMAL(4,2),
  "odometerOut"             INTEGER,
  "odometerIn"              INTEGER,
  "signatureDataUrl"        TEXT,
  "signerName"              TEXT,
  "signedAt"                TIMESTAMP(3),
  "signerIp"                TEXT,
  "termsVersion"            TEXT,
  "signatureToken"          TEXT,
  "signatureTokenExpiresAt" TIMESTAMP(3),
  "notes"                   TEXT,
  "finalizedAt"             TIMESTAMP(3),
  "closedAt"                TIMESTAMP(3),
  "closedByUserId"          TEXT,
  "locked"                  BOOLEAN NOT NULL DEFAULT false,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoanerAgreement_pkey" PRIMARY KEY ("id")
);

-- 3. LoanerPhoto ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "LoanerPhoto" (
  "id"                TEXT NOT NULL,
  "loanerAgreementId" TEXT NOT NULL,
  "tenantId"          TEXT,
  "kind"              "LoanerPhotoKind" NOT NULL,
  "angleLabel"        TEXT,
  "storagePath"       TEXT NOT NULL,
  "contentType"       TEXT,
  "sizeBytes"         INTEGER,
  "annotation"        TEXT,
  "takenAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "takenByUserId"     TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoanerPhoto_pkey" PRIMARY KEY ("id")
);

-- 4. LoanerDamagePoint ------------------------------------------------------
CREATE TABLE IF NOT EXISTS "LoanerDamagePoint" (
  "id"                TEXT NOT NULL,
  "loanerAgreementId" TEXT NOT NULL,
  "tenantId"          TEXT,
  "x"                 DOUBLE PRECISION NOT NULL,
  "y"                 DOUBLE PRECISION NOT NULL,
  "side"              TEXT,
  "severity"          "LoanerDamageSeverity" NOT NULL DEFAULT 'MINOR',
  "note"              TEXT,
  "preExisting"       BOOLEAN NOT NULL DEFAULT true,
  "photoId"           TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdByUserId"   TEXT,
  CONSTRAINT "LoanerDamagePoint_pkey" PRIMARY KEY ("id")
);

-- 5. Indexes ----------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "LoanerAgreement_agreementNumber_key" ON "LoanerAgreement"("agreementNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "LoanerAgreement_reservationId_key" ON "LoanerAgreement"("reservationId");
CREATE UNIQUE INDEX IF NOT EXISTS "LoanerAgreement_signatureToken_key" ON "LoanerAgreement"("signatureToken");
CREATE INDEX IF NOT EXISTS "LoanerAgreement_tenantId_status_idx" ON "LoanerAgreement"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "LoanerAgreement_vehicleId_createdAt_idx" ON "LoanerAgreement"("vehicleId", "createdAt");
CREATE INDEX IF NOT EXISTS "LoanerPhoto_loanerAgreementId_kind_idx" ON "LoanerPhoto"("loanerAgreementId", "kind");
CREATE INDEX IF NOT EXISTS "LoanerDamagePoint_loanerAgreementId_idx" ON "LoanerDamagePoint"("loanerAgreementId");

-- 6. Foreign keys (guarded so re-runs don't error) --------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanerAgreement_tenantId_fkey') THEN
    ALTER TABLE "LoanerAgreement" ADD CONSTRAINT "LoanerAgreement_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanerAgreement_reservationId_fkey') THEN
    ALTER TABLE "LoanerAgreement" ADD CONSTRAINT "LoanerAgreement_reservationId_fkey"
      FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanerAgreement_vehicleId_fkey') THEN
    ALTER TABLE "LoanerAgreement" ADD CONSTRAINT "LoanerAgreement_vehicleId_fkey"
      FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanerPhoto_loanerAgreementId_fkey') THEN
    ALTER TABLE "LoanerPhoto" ADD CONSTRAINT "LoanerPhoto_loanerAgreementId_fkey"
      FOREIGN KEY ("loanerAgreementId") REFERENCES "LoanerAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanerDamagePoint_loanerAgreementId_fkey') THEN
    ALTER TABLE "LoanerDamagePoint" ADD CONSTRAINT "LoanerDamagePoint_loanerAgreementId_fkey"
      FOREIGN KEY ("loanerAgreementId") REFERENCES "LoanerAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanerDamagePoint_photoId_fkey') THEN
    ALTER TABLE "LoanerDamagePoint" ADD CONSTRAINT "LoanerDamagePoint_photoId_fkey"
      FOREIGN KEY ("photoId") REFERENCES "LoanerPhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
