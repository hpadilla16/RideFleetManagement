-- Indexes for the /api/reservations/summary endpoint's findFirst queries.
-- The 5 COUNT queries are already cached via ReservationDailyCounter
-- (Phase 3 L-2). The 4 nextItem findFirst queries always run on every
-- summary cache miss; 2 of them lack proper index coverage and scale
-- linearly with table size. Profiling on 2026-05-03 showed summary p95
-- at 404ms (up from 180ms on 2026-05-02 baseline) — directly attributable
-- to data growth on these unindexed scans.
--
-- Idempotent: IF NOT EXISTS guards. Run from Supabase SQL editor (the
-- pgbouncer pooler hangs `prisma db push`, per memory).

-- (1) For: SELECT * FROM "Reservation"
--     WHERE "tenantId"=$1 AND "status"='NO_SHOW'
--     ORDER BY "updatedAt" DESC LIMIT 1
-- Prior coverage: [tenantId, status, pickupAt] — filters work but sort by
-- updatedAt requires an in-memory sort over all NO_SHOW rows for the tenant.
-- This index lets Postgres do an index-only scan + LIMIT 1.
CREATE INDEX IF NOT EXISTS "Reservation_tenantId_status_updatedAt_idx"
  ON "Reservation"("tenantId", "status", "updatedAt" DESC);

-- (2) For: SELECT * FROM "Reservation"
--     WHERE "tenantId"=$1 AND "notes" LIKE '%[FEE_ADVISORY_OPEN%'
--     ORDER BY "updatedAt" DESC LIMIT 1
-- `notes` is a free-text TEXT column with substring search — a regular
-- B-tree index can't accelerate `LIKE '%substr%'`. We use a partial index
-- with the predicate baked into the index definition, so it only contains
-- rows whose notes match the FEE_ADVISORY_OPEN sentinel. Postgres will
-- pick this index when the WHERE clause matches the predicate verbatim,
-- then read in [tenantId, updatedAt DESC] order for a sub-ms LIMIT 1.
--
-- NOTE: the predicate string must EXACTLY match the application code's
-- LIKE pattern. The summary endpoint uses `notes: { contains: '[FEE_ADVISORY_OPEN' }`,
-- which Prisma compiles to `notes ILIKE '%[FEE_ADVISORY_OPEN%'` (case-
-- insensitive). The partial index below uses LIKE (case-sensitive); the
-- planner will fall back to seq scan if the predicates don't match exactly.
-- That's acceptable here because the sentinel string is uppercase by
-- convention everywhere it's written. If we ever start seeing lowercase
-- sentinels, switch the index predicate to ILIKE OR add a lowercase
-- variant.
CREATE INDEX IF NOT EXISTS "Reservation_feeAdvisory_tenantId_updatedAt_partial_idx"
  ON "Reservation"("tenantId", "updatedAt" DESC)
  WHERE "notes" LIKE '%[FEE_ADVISORY_OPEN%';
