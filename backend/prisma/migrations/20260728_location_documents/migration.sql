-- 2026-07-28 - business documents per LOCATION.
--
-- WHY: a branch must keep paperwork current to trade legally - operating
-- permits, vehicle registrations, insurance certificates, licences. Today
-- those live in someone's inbox, and the first sign one lapsed is usually an
-- inspector. Operators need them filed against the location, with the date
-- they stop being valid, and a warning BEFORE that date.
--
-- WHY status is not an expiry column: expiry is DERIVED from expiresAt at read
-- time. A stored "valid/expired" flag would go stale the moment a day passes
-- without a sweep, and a document that merely LOOKS valid is worse than no
-- record at all. `status` here only tracks ACTIVE vs ARCHIVED (a superseded
-- upload is archived, never deleted, so an audit can still see what was on
-- file at any past date).
--
-- WHY expiresAt is nullable: some registrations are perpetual. NULL means "no
-- expiry" and such a row is never chased by the reminder sweep.
--
-- The file itself lives in Supabase Storage (private bucket, reads signed on
-- demand); only its path is stored here.
--
-- Additive + idempotent: one new table, no changes to existing ones.

CREATE TABLE IF NOT EXISTS "LocationDocument" (
  "id"               TEXT NOT NULL,
  "tenantId"         TEXT NOT NULL,
  "locationId"       TEXT NOT NULL,
  "docType"          TEXT NOT NULL,
  "label"            TEXT NOT NULL,
  "notes"            TEXT,
  "storagePath"      TEXT NOT NULL,
  "fileName"         TEXT,
  "mimeType"         TEXT,
  "sizeBytes"        INTEGER,
  "issuedAt"         DATE,
  "expiresAt"        DATE,
  "status"           TEXT NOT NULL DEFAULT 'ACTIVE',
  "uploadedByUserId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LocationDocument_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "LocationDocument"
    ADD CONSTRAINT "LocationDocument_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Cascade on location delete: the paperwork belongs to the branch, so it has
-- no meaning once the branch is gone.
DO $$ BEGIN
  ALTER TABLE "LocationDocument"
    ADD CONSTRAINT "LocationDocument_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The two hot reads: "show me this branch's active documents" and
-- "what expires soon across the tenant".
CREATE INDEX IF NOT EXISTS "LocationDocument_tenantId_locationId_status_idx"
  ON "LocationDocument"("tenantId", "locationId", "status");
CREATE INDEX IF NOT EXISTS "LocationDocument_tenantId_expiresAt_idx"
  ON "LocationDocument"("tenantId", "expiresAt");
