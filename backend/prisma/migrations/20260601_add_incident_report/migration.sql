-- Damage / Incident Report (2026-06-01). Reservation-anchored incident report
-- + evidence + tenant-editable clause library. Produces the dispute-ready PDF
-- matching the Go Kar sample. Works for rental, loaner, and car-sharing.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor (we apply there, not via `prisma db push`).
-- Plan: doc/damage-incident-report-plan-2026-06-01.md

-- 1. Enums --------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncidentReportType') THEN
    CREATE TYPE "IncidentReportType" AS ENUM ('DAMAGE', 'SMOKING', 'CLEANING', 'POLICY_VIOLATION', 'TOLL', 'LATE_RETURN', 'OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncidentReportStatus') THEN
    CREATE TYPE "IncidentReportStatus" AS ENUM ('DRAFT', 'ISSUED', 'DISPUTED', 'RESOLVED', 'CLOSED', 'VOID');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncidentEvidenceStatus') THEN
    CREATE TYPE "IncidentEvidenceStatus" AS ENUM ('CONFIRMED', 'VIOLATION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncidentReportSeverity') THEN
    CREATE TYPE "IncidentReportSeverity" AS ENUM ('MINOR', 'MODERATE', 'SEVERE');
  END IF;
END $$;

-- 2. ReservationIncident ------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ReservationIncident" (
  "id"                 TEXT NOT NULL,
  "tenantId"           TEXT,
  "reservationId"      TEXT NOT NULL,
  "rentalAgreementId"  TEXT,
  "reportNumber"       TEXT NOT NULL,
  "type"               "IncidentReportType" NOT NULL,
  "status"             "IncidentReportStatus" NOT NULL DEFAULT 'DRAFT',
  "severity"           "IncidentReportSeverity",
  "title"              TEXT NOT NULL,
  "discoveryAt"        TIMESTAMP(3) NOT NULL,
  "narrative"          TEXT,
  "preRentalCondition" TEXT,
  "odorNoted"          TEXT,
  "conditionAtReturn"  TEXT,
  "citedClausesJson"   TEXT,
  "rebuttalText"       TEXT,
  "chargeIdsJson"      TEXT,
  "depositApplied"     DECIMAL(10,2),
  "certifiedByName"    TEXT,
  "certifiedByTitle"   TEXT,
  "signatureDataUrl"   TEXT,
  "certifiedAt"        TIMESTAMP(3),
  "issuedAt"           TIMESTAMP(3),
  "revisionOfId"       TEXT,
  "createdByUserId"    TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReservationIncident_pkey" PRIMARY KEY ("id")
);

-- 3. IncidentEvidence ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS "IncidentEvidence" (
  "id"            TEXT NOT NULL,
  "incidentId"    TEXT NOT NULL,
  "tenantId"      TEXT,
  "ordinal"       INTEGER NOT NULL,
  "location"      TEXT NOT NULL,
  "description"   TEXT NOT NULL,
  "evidenceStatus" "IncidentEvidenceStatus" NOT NULL DEFAULT 'VIOLATION',
  "storagePath"   TEXT,
  "contentType"   TEXT,
  "sourcePhase"   TEXT,
  "takenAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "takenByUserId" TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IncidentEvidence_pkey" PRIMARY KEY ("id")
);

-- 4. AgreementClause (tenant-editable library) --------------------------------
CREATE TABLE IF NOT EXISTS "AgreementClause" (
  "id"          TEXT NOT NULL,
  "tenantId"    TEXT,
  "section"     TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "text"        TEXT NOT NULL,
  "amountRange" TEXT,
  "category"    "IncidentReportType",
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgreementClause_pkey" PRIMARY KEY ("id")
);

-- 5. Indexes ------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "ReservationIncident_reportNumber_key" ON "ReservationIncident"("reportNumber");
CREATE INDEX IF NOT EXISTS "ReservationIncident_tenantId_status_idx" ON "ReservationIncident"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "ReservationIncident_reservationId_idx" ON "ReservationIncident"("reservationId");
CREATE INDEX IF NOT EXISTS "IncidentEvidence_incidentId_ordinal_idx" ON "IncidentEvidence"("incidentId", "ordinal");
CREATE INDEX IF NOT EXISTS "AgreementClause_tenantId_active_idx" ON "AgreementClause"("tenantId", "active");

-- 6. Foreign keys (guarded) ---------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReservationIncident_tenantId_fkey') THEN
    ALTER TABLE "ReservationIncident" ADD CONSTRAINT "ReservationIncident_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReservationIncident_reservationId_fkey') THEN
    ALTER TABLE "ReservationIncident" ADD CONSTRAINT "ReservationIncident_reservationId_fkey"
      FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReservationIncident_revisionOfId_fkey') THEN
    ALTER TABLE "ReservationIncident" ADD CONSTRAINT "ReservationIncident_revisionOfId_fkey"
      FOREIGN KEY ("revisionOfId") REFERENCES "ReservationIncident"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'IncidentEvidence_incidentId_fkey') THEN
    ALTER TABLE "IncidentEvidence" ADD CONSTRAINT "IncidentEvidence_incidentId_fkey"
      FOREIGN KEY ("incidentId") REFERENCES "ReservationIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AgreementClause_tenantId_fkey') THEN
    ALTER TABLE "AgreementClause" ADD CONSTRAINT "AgreementClause_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
