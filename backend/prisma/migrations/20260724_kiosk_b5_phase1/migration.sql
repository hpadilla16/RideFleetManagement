-- Ride Kiosk — Fase B5 PHASE 1 (defensive half, 2026-07-24).
-- Design: doc/kiosk-b5-payment-design-2026-07-16.md (v2).
-- NO gateway code ships with this — every structure here is inert until the
-- iPOS/HPP layer lands (blocked on rep answers).
--
-- New: KioskSession payment-intent columns; PaymentOpsFlag (the concrete staff
-- queue) + its enums; a PARTIAL unique index that gives gateway payments a
-- real idempotency floor.
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor. Migrate via the SESSION port 5432, never pgbouncer 6543.

-- 1) KioskSession — one payment intent per session ---------------------------
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "paymentIntentRef" TEXT;
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "paymentIntentState" TEXT;
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "paymentIntentCreatedAt" TIMESTAMP(3);
-- Refs retained after a supersede — a superseded iPOS link may still be
-- payable (no documented cancel), so the old ref must stay resolvable.
ALTER TABLE "KioskSession" ADD COLUMN IF NOT EXISTS "paymentIntentPriorRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- MONEY-PATH UNIQUENESS (review M1). The inbound late-payment lookup resolves a
-- gateway reference to a reservation; without DB enforcement a mint collision
-- would bind a real payment to the WRONG reservation instead of failing loudly.
-- Safe to add: the column is 100% NULL today and Postgres permits many NULLs
-- under a unique index. Replaces the earlier non-unique index.
DROP INDEX IF EXISTS "KioskSession_paymentIntentRef_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "KioskSession_paymentIntentRef_key" ON "KioskSession" ("paymentIntentRef");
-- Array containment lookups for the retained superseded refs.
CREATE INDEX IF NOT EXISTS "KioskSession_paymentIntentPriorRefs_idx" ON "KioskSession" USING GIN ("paymentIntentPriorRefs");

-- 2) PaymentOpsFlag — the staff queue ----------------------------------------
DO $$ BEGIN CREATE TYPE "PaymentOpsKind" AS ENUM ('STRANDED_DEPOSIT_HOLD','ORPHAN_PAYMENT','ROLLBACK_FAILED','CARD_ON_FILE_FAILED','NAME_MISMATCH_REVIEW'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PaymentOpsStatus" AS ENUM ('NOT_ATTEMPTED','GATEWAY_FAILED','RESOLVED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PaymentOpsFlag" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "kind"              "PaymentOpsKind" NOT NULL,
  "status"            "PaymentOpsStatus" NOT NULL DEFAULT 'NOT_ATTEMPTED',
  "reservationId"     TEXT,
  "rentalAgreementId" TEXT,
  "kioskSessionId"    TEXT,
  "reference"         TEXT,
  "gatewayRef"        TEXT,
  "amount"            DECIMAL(10,2),
  "note"              TEXT,
  "lastError"         TEXT,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "raisedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"        TIMESTAMP(3),
  "resolvedByUserId"  TEXT,
  "resolvedNote"      TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentOpsFlag_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PaymentOpsFlag_tenantId_status_raisedAt_idx" ON "PaymentOpsFlag" ("tenantId","status","raisedAt");
CREATE INDEX IF NOT EXISTS "PaymentOpsFlag_tenantId_kind_status_idx"     ON "PaymentOpsFlag" ("tenantId","kind","status");
CREATE INDEX IF NOT EXISTS "PaymentOpsFlag_reservationId_idx"            ON "PaymentOpsFlag" ("reservationId");
CREATE INDEX IF NOT EXISTS "PaymentOpsFlag_reference_idx"                ON "PaymentOpsFlag" ("reference");
DO $$ BEGIN ALTER TABLE "PaymentOpsFlag" ADD CONSTRAINT "PaymentOpsFlag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) Idempotency floor for GATEWAY payments ----------------------------------
-- ⚠️ SCOPE DECISION (verified against PROD 2026-07-24, read-only):
--   a blanket UNIQUE ("reservationId","reference") CANNOT be created — prod has
--   72 duplicate groups / 144 rows. Every one of them is a STAFF-TYPED manual
--   reference (card last-4 like '****1111 · 1', auth codes like '003743',
--   'OTC-<ts>'), i.e. a customer who legitimately paid twice on one
--   reservation and staff typed the same last-4 both times. A blanket
--   constraint would both fail to create AND break legitimate manual entry.
--   The gateway namespace is CLEAN: AUTHNET: = 33 rows, 0 duplicates;
--   IPOS:/SPIN: = 0 rows.
-- So the floor is a PARTIAL unique index over machine-generated references
-- only. That is 100% of what B5 needs (webhook+poll racing into a double
-- payment row / double PreAuth) with zero impact on manual bookkeeping.
CREATE UNIQUE INDEX IF NOT EXISTS "ReservationPayment_reservationId_gatewayRef_key"
  ON "ReservationPayment" ("reservationId","reference")
  WHERE "reference" LIKE 'IPOS:%' OR "reference" LIKE 'AUTHNET:%' OR "reference" LIKE 'SPIN:%';
