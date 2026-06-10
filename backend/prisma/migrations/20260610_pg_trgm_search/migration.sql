-- Phase 0 hardening (2026-06-09) — trigram search indexes.
--
-- Customer/vehicle/reservation search uses ILIKE '%term%', which a btree
-- index can never serve; at ~10k rows these become the top slow queries
-- (scaling plan doc/scaling-capacity-plan-2026-06-09.md §5.3). pg_trgm GIN
-- indexes serve ILIKE/LIKE substring patterns directly.
--
-- ADDITIVE ONLY: creates one extension + indexes. No table/column changes,
-- no data changes, instantly reversible with DROP INDEX.
--
-- Notes:
--  * Runs inside the migration transaction (no CONCURRENTLY — table sizes
--    are small today, the lock window is sub-second; revisit if a table
--    passes ~100k rows).
--  * pg_trgm may already exist in the `extensions` schema (Supabase
--    convention) or land in `public` (default). The search_path below covers
--    both so gin_trgm_ops resolves either way. Nonexistent schemas in
--    search_path are ignored, so this is safe on vanilla Postgres too.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
SET LOCAL search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Vehicle list search (vehicles.service.js — internalNumber/plate/vin/make/model)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Vehicle_internalNumber_trgm_idx" ON "Vehicle" USING GIN ("internalNumber" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Vehicle_plate_trgm_idx"          ON "Vehicle" USING GIN ("plate" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Vehicle_vin_trgm_idx"            ON "Vehicle" USING GIN ("vin" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Vehicle_make_trgm_idx"           ON "Vehicle" USING GIN ("make" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Vehicle_model_trgm_idx"          ON "Vehicle" USING GIN ("model" gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Customer search — serves BOTH the raw-SQL list search (customers.service.js,
-- rewritten to ILIKE + `||` in this same ship) AND every Prisma
-- `contains/insensitive` path that filters on customer name/email/phone
-- (reservations, dealership-loaner, employee-app, issue-center claims).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Customer_firstName_trgm_idx" ON "Customer" USING GIN ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Customer_lastName_trgm_idx"  ON "Customer" USING GIN ("lastName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Customer_email_trgm_idx"     ON "Customer" USING GIN ("email" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Customer_phone_trgm_idx"     ON "Customer" USING GIN ("phone" gin_trgm_ops);

-- Full-name expression indexes — must match the query expressions in
-- customers.service.js EXACTLY ("First Last" and "Last First" arms).
CREATE INDEX IF NOT EXISTS "Customer_fullName_trgm_idx" ON "Customer"
  USING GIN (((COALESCE("firstName", '') || ' ' || COALESCE("lastName", ''))) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Customer_fullNameRev_trgm_idx" ON "Customer"
  USING GIN (((COALESCE("lastName", '') || ' ' || COALESCE("firstName", ''))) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Reservation search (reservations.service.js — reservationNumber/sourceRef)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Reservation_reservationNumber_trgm_idx" ON "Reservation" USING GIN ("reservationNumber" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Reservation_sourceRef_trgm_idx"         ON "Reservation" USING GIN ("sourceRef" gin_trgm_ops);
