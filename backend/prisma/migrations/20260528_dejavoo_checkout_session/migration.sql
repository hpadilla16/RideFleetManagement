-- =====================================================================
-- 2026-05-28 — Dejavoo Spin checkout redesign · Phase 1.1
-- Adds CheckoutSession state machine, HandoffToken QR tokens, per-section
-- T&C initials, and per-photo inspection annotations. Plus columns on
-- RentalAgreement for card-on-file + deposit pre-auth + T&C + decline
-- insurance, and Vehicle.lastOdometerSource for the "last odometer wins"
-- audit trail.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Enums
-- ---------------------------------------------------------------------
CREATE TYPE "CheckoutStep" AS ENUM (
  'CONFIRMING',
  'TC_PENDING',
  'TC_SIGNED',
  'PAYMENT_PENDING',
  'PAID',
  'INSPECTION_HANDOFF',
  'INSPECTION_IN_PROGRESS',
  'CUSTOMER_SIGN_PENDING',
  'FINALIZING',
  'CLOSED',
  'CANCELLED'
);

CREATE TYPE "HandoffTokenKind" AS ENUM (
  'TERMS_SIGNING',
  'MOBILE_INSPECTION'
);

-- ---------------------------------------------------------------------
-- 2) CheckoutSession
-- ---------------------------------------------------------------------
CREATE TABLE "CheckoutSession" (
  "id"                    TEXT PRIMARY KEY,
  "reservationId"         TEXT NOT NULL UNIQUE,
  "agreementId"           TEXT,
  "tenantId"              TEXT,
  "currentStep"           "CheckoutStep" NOT NULL DEFAULT 'CONFIRMING',
  "events"                TEXT NOT NULL,
  "tcCompletedAt"         TIMESTAMP(3),
  "paymentCompletedAt"    TIMESTAMP(3),
  "inspectionCompletedAt" TIMESTAMP(3),
  "customerSignedAt"      TIMESTAMP(3),
  "startedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"            TIMESTAMP(3),
  "abandonedAt"           TIMESTAMP(3),
  "abandonedReason"       TEXT,
  "startedByUserId"       TEXT,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CheckoutSession_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CheckoutSession_agreementId_fkey"
    FOREIGN KEY ("agreementId") REFERENCES "RentalAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "CheckoutSession_reservationId_idx"      ON "CheckoutSession"("reservationId");
CREATE INDEX "CheckoutSession_currentStep_idx"        ON "CheckoutSession"("currentStep");
CREATE INDEX "CheckoutSession_tenantId_currentStep_idx" ON "CheckoutSession"("tenantId", "currentStep");
CREATE INDEX "CheckoutSession_abandonedAt_idx"        ON "CheckoutSession"("abandonedAt");

-- ---------------------------------------------------------------------
-- 3) HandoffToken
-- ---------------------------------------------------------------------
CREATE TABLE "HandoffToken" (
  "id"              TEXT PRIMARY KEY,
  "reservationId"   TEXT NOT NULL,
  "kind"            "HandoffTokenKind" NOT NULL,
  "token"           TEXT NOT NULL UNIQUE,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "consumedAt"      TIMESTAMP(3),
  "createdByUserId" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HandoffToken_reservationId_fkey"
    FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "HandoffToken_token_expiresAt_idx"     ON "HandoffToken"("token", "expiresAt");
CREATE INDEX "HandoffToken_reservationId_kind_idx"  ON "HandoffToken"("reservationId", "kind");

-- ---------------------------------------------------------------------
-- 4) AgreementSectionInitial — per-section T&C initials
-- ---------------------------------------------------------------------
CREATE TABLE "AgreementSectionInitial" (
  "id"             TEXT PRIMARY KEY,
  "agreementId"    TEXT NOT NULL,
  "sectionKey"     TEXT NOT NULL,
  "sectionLabel"   TEXT NOT NULL,
  "initialDataUrl" TEXT NOT NULL,
  "signedAt"       TIMESTAMP(3) NOT NULL,
  "customerIp"     TEXT,

  CONSTRAINT "AgreementSectionInitial_agreementId_fkey"
    FOREIGN KEY ("agreementId") REFERENCES "RentalAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgreementSectionInitial_agreementId_sectionKey_key"
    UNIQUE ("agreementId", "sectionKey")
);
CREATE INDEX "AgreementSectionInitial_agreementId_idx" ON "AgreementSectionInitial"("agreementId");

-- ---------------------------------------------------------------------
-- 5) VehicleInspectionAnnotation — pin notes on inspection photos
-- ---------------------------------------------------------------------
CREATE TABLE "VehicleInspectionAnnotation" (
  "id"           TEXT PRIMARY KEY,
  "inspectionId" TEXT NOT NULL,
  "photoUrl"     TEXT NOT NULL,
  "x"            DOUBLE PRECISION NOT NULL,
  "y"            DOUBLE PRECISION NOT NULL,
  "note"         TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VehicleInspectionAnnotation_inspectionId_fkey"
    FOREIGN KEY ("inspectionId") REFERENCES "RentalAgreementInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "VehicleInspectionAnnotation_inspectionId_idx" ON "VehicleInspectionAnnotation"("inspectionId");

-- ---------------------------------------------------------------------
-- 6) RentalAgreement — new columns for Spin checkout
-- ---------------------------------------------------------------------
ALTER TABLE "RentalAgreement"
  ADD COLUMN "cardOnFileToken"        TEXT,
  ADD COLUMN "cardOnFileBrand"        TEXT,
  ADD COLUMN "cardOnFileLast4"        TEXT,
  ADD COLUMN "cardOnFileCapturedAt"   TIMESTAMP(3),

  ADD COLUMN "depositHoldId"          TEXT,
  ADD COLUMN "depositHoldAmount"      DECIMAL(10,2),
  ADD COLUMN "depositHoldExpiresAt"   TIMESTAMP(3),
  ADD COLUMN "depositHoldVoidedAt"    TIMESTAMP(3),

  ADD COLUMN "tcSignatureDataUrl"     TEXT,
  ADD COLUMN "tcSignedAt"             TIMESTAMP(3),
  ADD COLUMN "tcSignerName"           TEXT,
  ADD COLUMN "tcCustomerIp"           TEXT,

  ADD COLUMN "declinedInsurance"      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "declinedInsuranceSignatureDataUrl" TEXT,
  ADD COLUMN "declinedInsuranceSignedAt"         TIMESTAMP(3);

-- ---------------------------------------------------------------------
-- 7) Vehicle — odometer provenance
-- ---------------------------------------------------------------------
ALTER TABLE "Vehicle"
  ADD COLUMN "lastOdometerSource" TEXT;
