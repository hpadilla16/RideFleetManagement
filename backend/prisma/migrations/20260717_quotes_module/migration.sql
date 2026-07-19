-- Quotes module (2026-07-17) — doc/quotes-module-plan-2026-07-17.md
-- ADDITIVE ONLY: one enum + one self-contained table + indexes. No FK
-- constraints on purpose (plain-string ids; see schema comment). Reversible
-- with DROP TABLE + DROP TYPE.

DO $$ BEGIN CREATE TYPE "QuoteStatus" AS ENUM ('ACTIVE','EXPIRED','CONVERTED','CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Quote" (
  "id" TEXT NOT NULL,
  "quoteNumber" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT,
  "contactName" TEXT,
  "contactPhone" TEXT,
  "contactEmail" TEXT,
  "pickupLocationId" TEXT NOT NULL,
  "returnLocationId" TEXT,
  "vehicleTypeId" TEXT NOT NULL,
  "pickupAt" TIMESTAMP(3) NOT NULL,
  "returnAt" TIMESTAMP(3) NOT NULL,
  "days" INTEGER NOT NULL,
  "dailyRate" DECIMAL(10,2) NOT NULL,
  "subtotal" DECIMAL(10,2) NOT NULL,
  "fees" DECIMAL(10,2) NOT NULL,
  "taxes" DECIMAL(10,2) NOT NULL,
  "total" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "pricingSource" TEXT,
  "revenuePricingApplied" BOOLEAN NOT NULL DEFAULT false,
  "engineSnapshotJson" TEXT,
  "status" "QuoteStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "convertedReservationId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'STAFF',
  "createdByUserId" TEXT,
  "author" TEXT,
  "ticketId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Quote_tenantId_quoteNumber_key" ON "Quote"("tenantId", "quoteNumber");
CREATE INDEX IF NOT EXISTS "Quote_tenantId_status_idx" ON "Quote"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "Quote_tenantId_customerId_idx" ON "Quote"("tenantId", "customerId");
CREATE INDEX IF NOT EXISTS "Quote_tenantId_createdAt_idx" ON "Quote"("tenantId", "createdAt");
