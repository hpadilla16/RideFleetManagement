CREATE TYPE "TripIncidentLiabilityDecision" AS ENUM ('PENDING', 'CUSTOMER', 'TENANT', 'HOST', 'SHARED', 'WAIVED');
CREATE TYPE "TripIncidentChargeDecision" AS ENUM ('PENDING', 'CHARGE_CUSTOMER', 'CHARGE_HOST', 'CHARGE_TENANT', 'WAIVE');
CREATE TYPE "TripIncidentRecoveryStage" AS ENUM ('INTAKE', 'EVIDENCE', 'LIABILITY_REVIEW', 'READY_TO_CHARGE', 'CHARGED', 'WAIVED', 'CLOSED');

ALTER TABLE "TripIncident"
  ADD COLUMN "liabilityDecision" "TripIncidentLiabilityDecision" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "chargeDecision" "TripIncidentChargeDecision" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "recoveryStage" "TripIncidentRecoveryStage" NOT NULL DEFAULT 'INTAKE',
  ADD COLUMN "waiveReason" TEXT,
  ADD COLUMN "customerChargeReady" BOOLEAN NOT NULL DEFAULT false;
