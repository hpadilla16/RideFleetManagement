-- Per-employee program visibility (2026-07-02). User.programScope mirrors
-- Vehicle.programCategory but for employee accounts: a LOANER_ONLY employee
-- keeps all their modules but sees only loaner-side data; a RENTAL_ONLY
-- employee sees only rental-side data and loses the loaner module. BOTH
-- (default) = no filtering, so every existing user keeps exact current
-- behavior. ADMIN/SUPER_ADMIN bypass in code (lib/tenant-scope.js).
--
-- Additive only. Idempotent — safe to re-run and to paste into the Supabase
-- SQL editor (we apply there, not via `prisma db push`).
-- Migrate via the SESSION port 5432, never pgbouncer 6543.

-- 1. Enum ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmployeeProgramScope') THEN
    CREATE TYPE "EmployeeProgramScope" AS ENUM ('RENTAL_ONLY', 'LOANER_ONLY', 'BOTH');
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. User.programScope --------------------------------------------------------
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "programScope" "EmployeeProgramScope" NOT NULL DEFAULT 'BOTH';
