-- Per-tenant, per-day rollup of the count() metrics that
-- reservationsService.summary() returns. Updated out-of-band so the
-- dashboard endpoint can read from a single row instead of running 5
-- COUNT() queries per request.
--
-- Idempotent: IF NOT EXISTS guards let this run safely on already-migrated
-- environments (consistent with the rest of the migrations folder).

CREATE TABLE IF NOT EXISTS "ReservationDailyCounter" (
  "id"            TEXT        NOT NULL,
  -- tenantId NOT NULL on purpose: Postgres unique indexes don't treat
  -- NULL as equal, so allowing nullable tenantId would let (NULL, day)
  -- rows duplicate on every upsert. SUPER_ADMIN cross-tenant summary
  -- requests don't write here; they fall through to live aggregation.
  "tenantId"      TEXT        NOT NULL,
  "day"           TIMESTAMP(3) NOT NULL,
  "pickupsToday"  INTEGER     NOT NULL DEFAULT 0,
  "returnsToday"  INTEGER     NOT NULL DEFAULT 0,
  "checkedOut"    INTEGER     NOT NULL DEFAULT 0,
  "feeAdvisories" INTEGER     NOT NULL DEFAULT 0,
  "noShows"       INTEGER     NOT NULL DEFAULT 0,
  "refreshedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReservationDailyCounter_pkey" PRIMARY KEY ("id")
);

-- One row per (tenant, day). Upserts use this constraint.
CREATE UNIQUE INDEX IF NOT EXISTS "ReservationDailyCounter_tenantId_day_key"
  ON "ReservationDailyCounter"("tenantId", "day");

-- Lets the refresh path quickly find the most recently-refreshed row
-- per tenant when we ever wire up "freshness" checks at scale.
CREATE INDEX IF NOT EXISTS "ReservationDailyCounter_tenantId_refreshedAt_idx"
  ON "ReservationDailyCounter"("tenantId", "refreshedAt");
