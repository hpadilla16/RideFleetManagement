-- 2026-07-25 - review-tier commissions for counter staff (LAX #5). MONEY.
--
-- WHY: Hector's commission table - the counter employee's percent over what
-- they sell is driven by how many VALIDATED customer reviews they collected
-- (0-9 none, 10-19 2pct, 20-29 3pct, 30-39 4pct, 40-60 5pct, 61+ 6pct),
-- applying only to qualifying booking sources (Expedia/Priceline). Reviews
-- are proven by a photo the AI validates.
--
-- WHAT:
--   "ReviewProof" table - one row per submitted review photo, with AI
--     verdict fields. VALIDATED rows per (employee, monthKey) drive the tier.
--   CommissionPlan.reviewTiersJson / reviewTierSourcesJson - the tier scale
--     and qualifying sources. NULL = legacy catalog behavior (zero change
--     for tenants without tiers).
--
-- Additive + idempotent (IF NOT EXISTS REQUIRED: startup-migrate is
-- fail-open and retries every boot; workers race). Migrate via the SESSION
-- port 5432, never pgbouncer 6543.

CREATE TABLE IF NOT EXISTS "ReviewProof" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT,
  "employeeUserId" TEXT NOT NULL,
  "monthKey" TEXT NOT NULL,
  "reservationId" TEXT,
  "rentalAgreementId" TEXT,
  "photoJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING_AI',
  "aiConfidence" INTEGER,
  "aiPlatform" TEXT,
  "aiBusinessName" TEXT,
  "aiRating" INTEGER,
  "aiReviewerName" TEXT,
  "aiNotes" TEXT,
  "photoSha256" TEXT,
  "validatedAt" TIMESTAMPTZ,
  "reviewedByUserId" TEXT,
  "uploadedByUserId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ReviewProof_tenant_employee_month_status_idx"
  ON "ReviewProof"("tenantId", "employeeUserId", "monthKey", "status");

CREATE INDEX IF NOT EXISTS "ReviewProof_rentalAgreementId_idx"
  ON "ReviewProof"("rentalAgreementId");

-- Duplicate-photo detection (QA M2).
CREATE INDEX IF NOT EXISTS "ReviewProof_tenant_photoSha256_idx"
  ON "ReviewProof"("tenantId", "photoSha256");

ALTER TABLE "CommissionPlan"
  ADD COLUMN IF NOT EXISTS "reviewTiersJson" JSONB;

ALTER TABLE "CommissionPlan"
  ADD COLUMN IF NOT EXISTS "reviewTierSourcesJson" JSONB;
