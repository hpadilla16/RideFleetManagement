-- VozIA gap #4 (2026-07-15) — digits-only phone mirror for reliable voice lookup.
--
-- Customer search (customers.service.js) is ILIKE '%term%'. A caller who says
-- "7875551234" never matches a stored "(787) 555-1234". This adds a derived
-- digits-only column + a pg_trgm GIN index so the search can match the normalized
-- form. The column is populated on every write by the customerPhoneNormalize Prisma
-- extension (lib/prisma.js); existing rows are filled by
-- scripts/backfill-customer-phone-normalized.mjs (dry-run/--apply).
--
-- ADDITIVE ONLY: one nullable column + one index. No data changes here, no
-- table rewrite, instantly reversible (DROP INDEX + DROP COLUMN).

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "phoneNormalized" TEXT;

-- pg_trgm already installed by 20260610_pg_trgm_search; IF NOT EXISTS is idempotent.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SET LOCAL search_path = public, extensions;

CREATE INDEX IF NOT EXISTS "Customer_phoneNormalized_trgm_idx"
  ON "Customer" USING GIN ("phoneNormalized" gin_trgm_ops);
