-- Ride Kiosk — Fase B1 (2026-07-05).
-- Spec: doc/kiosk-e2e-spec-2026-07-04.md.
-- New: enums KioskDeviceStatus / KioskSessionKind / KioskSessionOutcome;
-- tables KioskDevice (paired lobby tablet, hashed rotatable token) +
-- KioskSession (per-customer funnel telemetry) + UpsellRule (per-channel
-- offer config, consumed by Fase B2).
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor. Migrate via the SESSION port 5432, never pgbouncer 6543.

-- 1) Enums (guarded so re-runs don't fail) -----------------------------------
DO $$ BEGIN CREATE TYPE "KioskDeviceStatus" AS ENUM ('ACTIVE','REVOKED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "KioskSessionKind" AS ENUM ('PICKUP','WALKUP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "KioskSessionOutcome" AS ENUM ('IN_PROGRESS','COMPLETED','ESCALATED','ABANDONED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) KioskDevice --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "KioskDevice" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "locationId"           TEXT NOT NULL,
  "name"                 TEXT NOT NULL,
  "tokenHash"            TEXT NOT NULL,
  "tokenVersion"         INTEGER NOT NULL DEFAULT 1,
  "pairingCodeHash"      TEXT,
  "pairingCodeExpiresAt" TIMESTAMP(3),
  "pairingAttempts"      INTEGER NOT NULL DEFAULT 0,
  "lookupMisses"         INTEGER NOT NULL DEFAULT 0,
  "lookupLockedUntil"    TIMESTAMP(3),
  "status"               "KioskDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
  "revokedAt"            TIMESTAMP(3),
  "rotatedAt"            TIMESTAMP(3),
  "walkupEnabled"        BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt"           TIMESTAMP(3),
  "appVersion"           TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KioskDevice_pkey" PRIMARY KEY ("id")
);
-- Per-device lookup lockout (Innovation review, 2026-07-05). Guarded ADDs so a
-- DB that ran an earlier paste of this migration converges on re-run.
ALTER TABLE "KioskDevice" ADD COLUMN IF NOT EXISTS "lookupMisses" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KioskDevice" ADD COLUMN IF NOT EXISTS "lookupLockedUntil" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "KioskDevice_tokenHash_key" ON "KioskDevice" ("tokenHash");
CREATE INDEX IF NOT EXISTS "KioskDevice_tenantId_locationId_idx" ON "KioskDevice" ("tenantId","locationId");

-- 3) KioskSession -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "KioskSession" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "deviceId"          TEXT NOT NULL,
  "kind"              "KioskSessionKind" NOT NULL,
  "reservationId"     TEXT,
  "checkoutSessionId" TEXT,
  "step"              TEXT NOT NULL DEFAULT 'WELCOME',
  "outcome"           "KioskSessionOutcome" NOT NULL DEFAULT 'IN_PROGRESS',
  "escalatedReason"   TEXT,
  "eventsJson"        JSONB NOT NULL,
  "idVerifiedAt"      TIMESTAMP(3),
  "idVerifyMethod"    TEXT,
  "assistUserId"      TEXT,
  "assistGrantedAt"   TIMESTAMP(3),
  "lastActivityAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"           TIMESTAMP(3),
  CONSTRAINT "KioskSession_pkey" PRIMARY KEY ("id")
);
-- Server-recorded ID-verify stamp (B3a review M2) + Staff Assist grant (B3c).
-- Guarded ADDs so a DB that ran an earlier paste of this migration converges.
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "idVerifiedAt" TIMESTAMP(3);
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "idVerifyMethod" TEXT;
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "assistUserId" TEXT;
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "assistGrantedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "KioskSession_tenantId_deviceId_startedAt_idx" ON "KioskSession" ("tenantId","deviceId","startedAt");
CREATE INDEX IF NOT EXISTS "KioskSession_tenantId_outcome_lastActivityAt_idx" ON "KioskSession" ("tenantId","outcome","lastActivityAt");
CREATE INDEX IF NOT EXISTS "KioskSession_reservationId_idx" ON "KioskSession" ("reservationId");

-- 4) UpsellRule ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "UpsellRule" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "channel"           TEXT NOT NULL,
  "prepaidServiceIds" TEXT[],
  "offerServiceIds"   TEXT[],
  "strategy"          TEXT NOT NULL,
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UpsellRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "UpsellRule_tenantId_channel_key" ON "UpsellRule" ("tenantId","channel");

-- 5) Foreign keys (guarded) ----------------------------------------------------
DO $$ BEGIN ALTER TABLE "KioskDevice" ADD CONSTRAINT "KioskDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "KioskDevice" ADD CONSTRAINT "KioskDevice_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "KioskSession" ADD CONSTRAINT "KioskSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "KioskSession" ADD CONSTRAINT "KioskSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "KioskDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "KioskSession" ADD CONSTRAINT "KioskSession_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "UpsellRule" ADD CONSTRAINT "UpsellRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
