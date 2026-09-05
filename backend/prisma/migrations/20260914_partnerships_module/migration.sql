-- Partnerships module (2026-09-05) — doc/partnerships-module-plan-2026-09-05.md
-- Additive + idempotent (startup-migrate retries on next boot). Inert on deploy:
-- Tenant.partnershipsEnabled defaults false, nothing reads the new tables until
-- a tenant is switched on, and every new Reservation/AdditionalService column
-- is nullable.

-- Tenant: per-tenant entitlement + hosted-page domain override.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "partnershipsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "partnerHostedBaseUrl" TEXT;

-- Enums. DO-block guard because CREATE TYPE has no IF NOT EXISTS.
DO $$ BEGIN
  CREATE TYPE "PartnerStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "PartnerKind" AS ENUM ('INSURANCE', 'CORPORATE', 'COOPERATIVE', 'HOTEL', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE "PartnerVehicleMode" AS ENUM ('SHOW_INVENTORY', 'PREFERRED_TYPE', 'ASSIGN_AT_PICKUP');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Partner" (
  "id"                        TEXT PRIMARY KEY,
  "tenantId"                  TEXT NOT NULL,
  "slug"                      TEXT NOT NULL,
  "code"                      TEXT NOT NULL,
  "kind"                      "PartnerKind" NOT NULL DEFAULT 'OTHER',
  "name"                      TEXT NOT NULL,
  "logoRef"                   TEXT,
  "status"                    "PartnerStatus" NOT NULL DEFAULT 'DRAFT',
  "validFrom"                 TIMESTAMP(3),
  "validTo"                   TIMESTAMP(3),
  "contactName"               TEXT,
  "contactEmail"              TEXT,
  "contactPhone"              TEXT,
  "landingJson"               JSONB,
  "termsJson"                 JSONB,
  "termsVersion"              INTEGER NOT NULL DEFAULT 1,
  "showTenantTerms"           BOOLEAN NOT NULL DEFAULT true,
  "showTenantContact"         BOOLEAN NOT NULL DEFAULT true,
  "rateId"                    TEXT,
  "discountPct"               DECIMAL(5,2),
  "vehicleMode"               "PartnerVehicleMode" NOT NULL DEFAULT 'SHOW_INVENTORY',
  "allowedVehicleTypeIds"     JSONB,
  "defaultVehicleTypeId"      TEXT,
  "coverageDisclosureJson"    JSONB,
  "coverageDisclosureVersion" INTEGER NOT NULL DEFAULT 1,
  "preferredTypePricing"      TEXT NOT NULL DEFAULT 'CONFIRM_AT_PICKUP',
  "askPolicyNumber"           BOOLEAN NOT NULL DEFAULT false,
  "locationIds"               JSONB,
  "visitCount"                INTEGER NOT NULL DEFAULT 0,
  "lastVisitAt"               TIMESTAMP(3),
  "createdBy"                 TEXT,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "Partner_tenantId_slug_key" ON "Partner" ("tenantId", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "Partner_tenantId_code_key" ON "Partner" ("tenantId", "code");
CREATE UNIQUE INDEX IF NOT EXISTS "Partner_rateId_key" ON "Partner" ("rateId");
CREATE INDEX IF NOT EXISTS "Partner_tenantId_status_idx" ON "Partner" ("tenantId", "status");
DO $$ BEGIN
  ALTER TABLE "Partner" ADD CONSTRAINT "Partner_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "Partner" ADD CONSTRAINT "Partner_rateId_fkey" FOREIGN KEY ("rateId") REFERENCES "Rate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PartnerService" (
  "id"                  TEXT PRIMARY KEY,
  "partnerId"           TEXT NOT NULL,
  "additionalServiceId" TEXT NOT NULL,
  "rateOverride"        DECIMAL(10,2),
  "mandatory"           BOOLEAN NOT NULL DEFAULT false,
  "sortOrder"           INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "PartnerService_partnerId_additionalServiceId_key" ON "PartnerService" ("partnerId", "additionalServiceId");
DO $$ BEGIN
  ALTER TABLE "PartnerService" ADD CONSTRAINT "PartnerService_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  -- CASCADE: deleting a company service in Settings removes it from every program (RESTRICT would 500 there).
  ALTER TABLE "PartnerService" ADD CONSTRAINT "PartnerService_additionalServiceId_fkey" FOREIGN KEY ("additionalServiceId") REFERENCES "AdditionalService"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PartnerAuditLog" (
  "id"          TEXT PRIMARY KEY,
  "tenantId"    TEXT NOT NULL,
  "partnerId"   TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorRole"   TEXT,
  "action"      TEXT NOT NULL,
  "changed"     JSONB NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PartnerAuditLog_tenantId_partnerId_createdAt_idx" ON "PartnerAuditLog" ("tenantId", "partnerId", "createdAt");
DO $$ BEGIN
  ALTER TABLE "PartnerAuditLog" ADD CONSTRAINT "PartnerAuditLog_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AdditionalService: partner-only services. Every non-partner catalog filters partnerId IS NULL.
ALTER TABLE "AdditionalService" ADD COLUMN IF NOT EXISTS "partnerId" TEXT;
CREATE INDEX IF NOT EXISTS "AdditionalService_partnerId_idx" ON "AdditionalService" ("partnerId");
DO $$ BEGIN
  ALTER TABLE "AdditionalService" ADD CONSTRAINT "AdditionalService_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reservation: attribution + what the customer accepted (stamped by F2's checkout).
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "partnerId" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "partnerTermsVersion" INTEGER;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "partnerPreferredVehicleTypeId" TEXT;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "partnerDisclosureAcceptedAt" TIMESTAMP(3);
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "partnerDisclosureVersion" INTEGER;
ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "partnerPolicyNumber" TEXT;
CREATE INDEX IF NOT EXISTS "Reservation_partnerId_idx" ON "Reservation" ("partnerId");
DO $$ BEGIN
  ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
