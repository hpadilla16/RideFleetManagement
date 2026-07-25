-- 2026-07-25 - Virtual Agent person type + per-kind commission plans (LAX #4).
--
-- WHY: virtual agents sell add-ons remotely and earn 1% of everything they
-- sell (additional services + insurance, excluding taxes and fees) on the
-- agreements they originate - ALONGSIDE the checkout employee's commission,
-- never instead of it. personKind on "User" persists the type (the derived
-- ADMIN/EMPLOYEE/HOST triad has no storage); personKind on "CommissionPlan"
-- lets the sync resolve a virtual-agent plan by kind.
--
-- Additive + idempotent (IF NOT EXISTS / duplicate_object guard REQUIRED:
-- startup-migrate is fail-open and retries every boot; multiple workers race
-- to apply). Enum + NOT NULL DEFAULT on an enum column and a nullable TEXT
-- are metadata-only in PG 11+. Migrate via the SESSION port 5432, never
-- pgbouncer 6543.

DO $$ BEGIN
  CREATE TYPE "EmployeePersonKind" AS ENUM ('STANDARD', 'VIRTUAL_AGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "personKind" "EmployeePersonKind" NOT NULL DEFAULT 'STANDARD';

ALTER TABLE "CommissionPlan"
  ADD COLUMN IF NOT EXISTS "personKind" TEXT;

-- WHO originated the reservation (QA B1): the staff create route stamps the
-- acting user; agreement creation seeds salesOwnerUserId from it when the
-- originator is a VIRTUAL_AGENT. Soft reference, nullable, no FK.
ALTER TABLE "Reservation"
  ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;
