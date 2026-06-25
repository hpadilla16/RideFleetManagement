-- Public loaner self-service (2026-06-25). Additive, idempotent. Migrate via SESSION port 5432.
-- LoanerRequest = "request a courtesy car" lead from the public website; advisor works it.
-- Reservation.loanerSelfServiceSubmittedAt = customer picked a loaner + signed online (PENDING approval).

CREATE TABLE IF NOT EXISTS "LoanerRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT,
  "repairOrderNumber" TEXT,
  "preferredDate" TIMESTAMP(3),
  "notes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LoanerRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LoanerRequest_tenantId_status_idx" ON "LoanerRequest"("tenantId", "status");

DO $$ BEGIN
  ALTER TABLE "LoanerRequest" ADD CONSTRAINT "LoanerRequest_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "loanerSelfServiceSubmittedAt" TIMESTAMP(3);
